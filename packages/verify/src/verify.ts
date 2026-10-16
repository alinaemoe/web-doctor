import { isSameOrigin, normalizeUrl } from "@webdoctor/core";
import type {
  Issue,
  LinkCheck,
  NodeSignature,
  PageSnapshot,
  ScanResult,
  ScanViewport,
  UnverifiedReason,
  Verification,
} from "@webdoctor/core";
import { fingerprintDraft, pageRules, siteRules } from "@webdoctor/rules";
import type { IssueDraft, SiteContext } from "@webdoctor/rules";
import {
  checkLinks,
  collectPage,
  fetchText,
  launchBrowser,
  parseSitemapLocs,
} from "@webdoctor/scanner";
import type { ArtifactStore, BrowserHandle, CollectResult } from "@webdoctor/scanner";

export interface VerifyOptions {
  pageTimeoutMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Test seam: replaces the real page collection. */
  collect?: (url: string, viewport: ScanViewport, opts: CollectHints) => Promise<CollectResult>;
}

export interface CollectHints {
  axe: boolean;
  probes: string[];
}

/** Verify Fix never writes screenshots. */
const NO_ARTIFACTS: ArtifactStore = {
  write: async () => undefined,
  read: async () => new Uint8Array(),
};

const isSiteLevel = (issue: Issue) => issue.ruleId.startsWith("seo.sitemap.");
const needsLinkCheck = (issue: Issue) =>
  issue.ruleId.startsWith("link.") || issue.ruleId === "seo.canonical.invalid";

const viewportsOf = (issue: Issue): ScanViewport[] =>
  issue.viewport === "all" ? ["desktop", "mobile"] : [issue.viewport];

/**
 * How well two element signatures agree: id 3, accessible name 2 (the roles must not disagree),
 * DOM path 1. Used to find an element again when its exact fingerprint no longer matches.
 */
export function signatureScore(a: NodeSignature, b: NodeSignature): number {
  let score = 0;
  if (a.id && a.id === b.id) score += 3;
  const nameA = a.accessibleName?.trim().toLowerCase();
  const nameB = b.accessibleName?.trim().toLowerCase();
  if (nameA && nameA === nameB && (!a.role || !b.role || a.role === b.role)) score += 2;
  if (a.domPath && a.domPath === b.domPath) score += 1;
  return score;
}

const RELOCATION_MIN_SCORE = 2;

function domEvidenceOf(issue: Issue) {
  return issue.evidence.find((e) => e.type === "dom");
}

function syntheticScan(origin: string, linkChecks: Record<string, LinkCheck>): ScanResult {
  const now = new Date().toISOString();
  return {
    scannerVersion: "verify",
    startUrl: origin + "/",
    origin,
    startedAt: now,
    finishedAt: now,
    partial: false,
    pages: [],
    skipped: [],
    linkChecks,
    robots: { url: origin + "/robots.txt" },
    sitemap: { url: origin + "/sitemap.xml", locs: [], declaredInRobots: false },
  };
}

interface Judgement {
  outcome: Verification["outcome"];
  detail: string;
  confidence: number;
  relocated?: boolean;
  elementGone?: boolean;
  reason?: UnverifiedReason;
}

function unverified(detail: string, reason: UnverifiedReason): Judgement {
  return { outcome: "unverified", detail, confidence: 0, reason };
}

/** Decides what a fresh page snapshot says about one old issue. */
function judge(issue: Issue, snapshot: PageSnapshot, site: SiteContext): Judgement {
  if (snapshot.status >= 400) {
    return unverified(
      `The page now answers ${snapshot.status}, so the check could not run.`,
      "page_unreachable",
    );
  }

  // A link/canonical rule can only be judged when its target was actually re-checked.
  if (needsLinkCheck(issue)) {
    const target = linkTargetOf(issue, snapshot);
    if (!target || !site.check(target)) {
      return unverified("The link target could not be re-checked.", "page_unreachable");
    }
  }

  const drafts = [...pageRules(snapshot, site), ...siteRules([snapshot], site)]
    .filter((d) => d.ruleId === issue.ruleId)
    .map((draft) => ({ draft, fingerprint: fingerprintDraft(draft) }));

  const exact = drafts.find((d) => d.fingerprint === issue.fingerprint);
  if (exact) {
    if (exact.draft.verdict === "unverified") {
      return unverified(
        "The check is still not conclusive (the server limits or blocks automated requests).",
        exact.draft.unverifiedReason ?? "blocked",
      );
    }
    return { outcome: "still-failing", detail: "The problem is still there.", confidence: 1 };
  }

  // The element may have moved (new path/index) while the problem stayed: match by signature.
  const oldDom = domEvidenceOf(issue);
  if (oldDom) {
    let best: { draft: IssueDraft; score: number } | undefined;
    for (const { draft } of drafts) {
      if (draft.verdict !== "fail") continue;
      const dom = draft.evidence.find((e) => e.type === "dom");
      if (!dom) continue;
      const score = signatureScore(oldDom.nodeSignature, dom.nodeSignature);
      if (!best || score > best.score) best = { draft, score };
    }
    if (best && best.score >= RELOCATION_MIN_SCORE) {
      return {
        outcome: "still-failing",
        detail: "The problem is still there; the element was found again at a different position.",
        confidence: 0.7,
        relocated: true,
      };
    }
  }

  const gone = oldDom ? snapshot.probes?.[oldDom.selector] === false : false;
  return gone
    ? {
        outcome: "verified-fixed",
        detail:
          "The check passes and the original element no longer exists on the page (it was changed or removed).",
        confidence: 0.75,
        elementGone: true,
      }
    : {
        outcome: "verified-fixed",
        detail: "The check passes on the current page.",
        confidence: 1,
      };
}

function linkTargetOf(issue: Issue, snapshot: PageSnapshot): string | null {
  if (issue.ruleId === "seo.canonical.invalid") {
    return snapshot.canonical ? normalizeUrl(snapshot.canonical, snapshot.finalUrl) : null;
  }
  const net = issue.evidence.find((e) => e.type === "network");
  return net ? normalizeUrl(net.requestUrl) : null;
}

type Collected = { ok: true; snapshot: PageSnapshot } | { ok: false; detail: string };

function combine(
  issue: Issue,
  parts: { viewport: ScanViewport; judgement: Judgement; status?: number }[],
  checkedAt: string,
): Verification {
  const failing = parts.find((p) => p.judgement.outcome === "still-failing");
  const unknown = parts.find((p) => p.judgement.outcome === "unverified");
  // One viewport that still fails is enough; a fix has to work everywhere the issue was seen.
  const chosen = failing ?? unknown ?? parts[0]!;
  const j = chosen.judgement;
  const where = parts.length > 1 ? ` (${chosen.viewport})` : "";
  const fixedEverywhere = parts.every((p) => p.judgement.outcome === "verified-fixed");

  return {
    issueId: issue.id,
    outcome: j.outcome,
    detail: fixedEverywhere
      ? parts.some((p) => p.judgement.elementGone)
        ? parts.find((p) => p.judgement.elementGone)!.judgement.detail
        : parts[0]!.judgement.detail
      : `${j.detail}${where}`,
    checkedAt,
    confidence: fixedEverywhere
      ? Math.min(...parts.map((p) => p.judgement.confidence))
      : j.confidence,
    relocated: j.relocated || undefined,
    elementGone: fixedEverywhere
      ? parts.some((p) => p.judgement.elementGone) || undefined
      : undefined,
    reason: j.reason,
    pages: parts.map((p) => ({ url: issue.pageUrl, viewport: p.viewport, status: p.status })),
  };
}

/**
 * Re-checks issues against the live site. Only the page(s) and rule(s) behind each issue are
 * examined (no crawling, no screenshots). An unreachable page, a failed navigation or a link target
 * that cannot be re-checked yields `unverified`: it never turns into "fixed".
 */
export async function verifyIssues(
  issues: Issue[],
  options: VerifyOptions = {},
): Promise<Verification[]> {
  if (issues.length === 0) return [];
  const checkedAt = () => new Date().toISOString();
  const out = new Map<string, Verification>();
  const checkOpts = { userAgent: options.userAgent };

  // ---- site-level issues (sitemap): re-fetch instead of loading a page ----
  for (const issue of issues.filter(isSiteLevel)) {
    out.set(issue.id, await verifySitemapIssue(issue, checkOpts, checkedAt()));
  }

  const pageIssues = issues.filter((i) => !isSiteLevel(i));
  if (pageIssues.length === 0) return issues.map((i) => out.get(i.id)!);

  let browser: BrowserHandle | undefined;
  const collect =
    options.collect ??
    (async (url: string, viewport: ScanViewport, hints: CollectHints) => {
      browser ??= await launchBrowser();
      return collectPage(browser, url, {
        viewport,
        depth: 0,
        artifacts: NO_ARTIFACTS,
        pageTimeoutMs: options.pageTimeoutMs ?? 30_000,
        userAgent: options.userAgent,
        screenshot: false,
        axe: hints.axe,
        probes: hints.probes,
      });
    });

  try {
    // One page load per (url, viewport), shared by all issues that sit on it.
    const wanted = new Map<string, { url: string; viewport: ScanViewport; issues: Issue[] }>();
    for (const issue of pageIssues) {
      for (const viewport of viewportsOf(issue)) {
        const key = `${issue.pageUrl}|${viewport}`;
        const entry = wanted.get(key) ?? { url: issue.pageUrl, viewport, issues: [] };
        entry.issues.push(issue);
        wanted.set(key, entry);
      }
    }

    const collected = new Map<string, Collected>();
    for (const [key, w] of wanted) {
      if (options.signal?.aborted) break;
      const result = await collect(w.url, w.viewport, {
        axe: w.issues.some((i) => i.ruleId.startsWith("a11y.")),
        probes: w.issues.flatMap((i) => {
          const dom = domEvidenceOf(i);
          return dom && !dom.selector.includes(">>>") ? [dom.selector] : [];
        }),
      });
      collected.set(
        key,
        result.ok
          ? { ok: true, snapshot: result.snapshot }
          : { ok: false, detail: `${result.reason}: ${result.detail}` },
      );
    }

    // Re-check the link targets that link/canonical rules depend on.
    const linkChecks = new Map<string, LinkCheck>();
    const targets = new Set<string>();
    for (const issue of pageIssues.filter(needsLinkCheck)) {
      for (const viewport of viewportsOf(issue)) {
        const c = collected.get(`${issue.pageUrl}|${viewport}`);
        const target = c?.ok ? linkTargetOf(issue, c.snapshot) : null;
        if (target) targets.add(target);
      }
    }
    if (targets.size > 0) {
      await checkLinks(targets, linkChecks, { ...checkOpts, signal: options.signal });
    }

    for (const issue of pageIssues) {
      const parts = viewportsOf(issue).map((viewport) => {
        const c = collected.get(`${issue.pageUrl}|${viewport}`);
        if (!c) {
          return { viewport, judgement: unverified("The check was canceled.", "timeout") };
        }
        if (!c.ok) {
          return {
            viewport,
            judgement: unverified(
              `The page could not be loaded (${c.detail}), so the problem cannot be re-checked.`,
              "page_unreachable",
            ),
          };
        }
        const origin = new URL(c.snapshot.finalUrl).origin;
        const site: SiteContext = {
          scan: syntheticScan(origin, Object.fromEntries(linkChecks)),
          check: (url) => linkChecks.get(url),
        };
        return {
          viewport,
          judgement: judge(issue, c.snapshot, site),
          status: c.snapshot.status,
        };
      });
      out.set(issue.id, combine(issue, parts, checkedAt()));
    }
  } finally {
    await (browser as BrowserHandle | undefined)?.close().catch(() => undefined);
  }

  return issues.map((i) => out.get(i.id)!);
}

async function verifySitemapIssue(
  issue: Issue,
  checkOpts: { userAgent?: string },
  checkedAt: string,
): Promise<Verification> {
  const sitemapUrl = issue.pageUrl;
  const origin = new URL(sitemapUrl).origin;
  const robots = await fetchText(`${origin}/robots.txt`, checkOpts);
  const sitemap = await fetchText(sitemapUrl, checkOpts);
  const base = { issueId: issue.id, checkedAt, pages: [] as Verification["pages"] };

  if (sitemap.error) {
    return {
      ...base,
      outcome: "unverified",
      detail: `The sitemap could not be fetched (${sitemap.error}).`,
      confidence: 0,
      reason: "page_unreachable",
    };
  }

  const locs = parseSitemapLocs(sitemap.text);
  const cache = new Map<string, LinkCheck>();
  await checkLinks(
    locs.map((l) => normalizeUrl(l)).filter((u): u is string => !!u && isSameOrigin(u, origin)),
    cache,
    checkOpts,
  );
  const scan = syntheticScan(origin, Object.fromEntries(cache));
  scan.sitemap = {
    url: sitemapUrl,
    status: sitemap.status,
    locs,
    declaredInRobots: /^\s*sitemap\s*:/im.test(robots.text ?? ""),
  };
  const site: SiteContext = { scan, check: (u) => cache.get(u) };
  // One issue per sitemap rule: any remaining finding means it is not fixed yet.
  const drafts = siteRules([], site).filter((d) => d.ruleId === issue.ruleId);

  return drafts.length > 0
    ? {
        ...base,
        outcome: "still-failing",
        detail: "The sitemap still has this problem.",
        confidence: 1,
      }
    : {
        ...base,
        outcome: "verified-fixed",
        detail: "The sitemap check passes now.",
        confidence: 1,
      };
}
