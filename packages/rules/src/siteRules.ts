import { isSameOrigin, normalizeUrl } from "@webdoctor/core";
import type {
  Evidence,
  LinkCheck,
  LinkInfo,
  PageSnapshot,
  UnverifiedReason,
} from "@webdoctor/core";
import { makeDraft, pagePathOf } from "./draft";
import type { IssueDraft, SiteContext } from "./draft";

const MAX_REDIRECTS_OK = 2;

function networkEvidence(target: string, check: LinkCheck): Evidence {
  return {
    type: "network",
    requestUrl: target,
    method: "GET",
    status: check.status,
    redirectChain: check.chain.length
      ? [...check.chain.map((h) => h.url), ...(check.finalUrl ? [check.finalUrl] : [])]
      : undefined,
    resourceType: "document",
    errorText: check.errorText,
  };
}

function linkEvidence(link: LinkInfo): Evidence {
  return {
    type: "dom",
    selector: link.selector,
    htmlSnippet: link.htmlSnippet,
    boundingBox: link.boundingBox,
    nodeSignature: link.nodeSignature,
  };
}

function externalVerdict(
  check: LinkCheck,
): { verdict: "fail" | "unverified"; reason?: UnverifiedReason; confidence: number } | null {
  if (check.error === "timeout")
    return { verdict: "unverified", reason: "timeout", confidence: 0.4 };
  if (check.error === "dns") return { verdict: "unverified", reason: "dns", confidence: 0.4 };
  if (check.error) return { verdict: "unverified", reason: "blocked", confidence: 0.4 };
  const status = check.status ?? 0;
  if (status === 429) return { verdict: "unverified", reason: "rate_limited", confidence: 0.4 };
  if ([401, 403, 999].includes(status))
    return { verdict: "unverified", reason: "blocked", confidence: 0.4 };
  if (status === 404 || status === 410) return { verdict: "fail", confidence: 0.9 };
  if (status >= 500) return { verdict: "fail", confidence: 0.6 };
  if (check.loop) return { verdict: "fail", confidence: 0.8 };
  return null;
}

function linkIssues(page: PageSnapshot, site: SiteContext): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const where = (link: LinkInfo) => `Page ${pagePathOf(page.url)}, link ${link.selector}`;

  for (const link of page.links) {
    const target = normalizeUrl(link.href);
    if (!target || target === normalizeUrl(page.url)) continue;
    const check = site.check(target);
    if (!check) continue;
    const evidence = [linkEvidence(link), networkEvidence(target, check)];
    const label = link.text ? `"${link.text}" → ${target}` : target;

    if (!isSameOrigin(target, page.url)) {
      const v = externalVerdict(check);
      if (!v) continue;
      drafts.push(
        makeDraft({
          ruleId: "link.external.broken",
          page,
          evidence,
          verdict: v.verdict,
          unverifiedReason: v.reason,
          confidence: v.confidence,
          what:
            v.verdict === "fail"
              ? `The external link ${label} is broken (${check.status ?? check.errorText}).`
              : `The external link ${label} could not be verified (${v.reason}); it is not necessarily broken.`,
          where: where(link),
        }),
      );
      continue;
    }

    if (check.loop || check.tooManyHops) {
      drafts.push(
        makeDraft({
          ruleId: "link.internal.redirect-loop",
          page,
          evidence,
          what: `The link ${label} ${check.loop ? "redirects in a loop" : "exceeds the redirect limit"}.`,
          where: where(link),
        }),
      );
    } else if (check.error === "timeout") {
      drafts.push(
        makeDraft({
          ruleId: "link.internal.broken",
          page,
          evidence,
          verdict: "unverified",
          unverifiedReason: "timeout",
          confidence: 0.4,
          what: `The internal link ${label} timed out.`,
          where: where(link),
        }),
      );
    } else if (check.error || (check.status ?? 0) >= 400) {
      drafts.push(
        makeDraft({
          ruleId: "link.internal.broken",
          page,
          evidence,
          confidence: check.error ? 0.6 : (check.status ?? 0) >= 500 ? 0.7 : 1,
          what: `The internal link ${label} is broken (${check.status ?? check.errorText}).`,
          where: where(link),
        }),
      );
    } else if (check.chain.length > MAX_REDIRECTS_OK) {
      drafts.push(
        makeDraft({
          ruleId: "link.internal.redirect-chain",
          page,
          evidence,
          confidence: 0.9,
          what: `The link ${label} goes through ${check.chain.length} redirects before reaching ${check.finalUrl}.`,
          where: where(link),
          after: `<a href="${check.finalUrl}">…</a>`,
        }),
      );
    }
  }
  return drafts;
}

function sitemapIssues(site: SiteContext): IssueDraft[] {
  const { sitemap, origin } = site.scan;
  const page = { url: sitemap.url, viewport: "all" as const };

  if (sitemap.declaredInRobots && sitemap.status !== 200) {
    return [
      makeDraft({
        ruleId: "seo.sitemap.unreachable",
        page,
        evidence: [
          {
            type: "network",
            requestUrl: sitemap.url,
            method: "GET",
            status: sitemap.status,
            resourceType: "document",
            errorText: sitemap.error,
          },
        ],
        what: `robots.txt declares the sitemap ${sitemap.url}, but it ${sitemap.status ? `answers ${sitemap.status}` : `could not be fetched (${sitemap.error})`}.`,
        where: `robots.txt on ${origin}`,
      }),
    ];
  }

  const bad = sitemap.locs
    .map((loc) => normalizeUrl(loc))
    .filter((u): u is string => Boolean(u) && isSameOrigin(u!, origin))
    .map((u) => ({ url: u, check: site.check(u) }))
    .filter((x) => x.check && !x.check.error && (x.check.status ?? 0) >= 400);
  if (bad.length === 0) return [];

  return [
    makeDraft({
      ruleId: "seo.sitemap.bad-entries",
      page,
      evidence: bad.slice(0, 10).map((x) => networkEvidence(x.url, x.check!)),
      what: `${bad.length} sitemap URL(s) do not work, e.g. ${bad[0]!.url} (${bad[0]!.check!.status}).`,
      where: `Sitemap ${sitemap.url}`,
    }),
  ];
}

export function siteRules(pages: PageSnapshot[], site: SiteContext): IssueDraft[] {
  return [...pages.flatMap((p) => linkIssues(p, site)), ...sitemapIssues(site)];
}
