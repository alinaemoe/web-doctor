import { randomUUID } from "node:crypto";
import {
  computeFingerprint,
  evidenceKeyForRequest,
  normalizeEvidenceText,
  stableElementKey,
} from "@webdoctor/core";
import type { Category, Evidence, Issue, IssueGroup, ScanResult, Viewport } from "@webdoctor/core";
import type { IssueDraft, SiteContext } from "./draft";
import { pageRules } from "./pageRules";
import { stabilizeSelector } from "./selectors";
import { siteRules } from "./siteRules";

export interface AnalyzeOptions {
  runId: string;
  categories?: Category[];
  /** ISO timestamp used for status history (defaults to now). */
  now?: string;
}

export interface AnalyzeResult {
  issues: Issue[];
  groups: IssueGroup[];
}

function elementKeyOf(evidence: Evidence[]): string {
  const dom = evidence.find((e) => e.type === "dom");
  return dom ? stableElementKey(dom.nodeSignature) || dom.selector : "";
}

function evidenceKeyOf(evidence: Evidence[]): string {
  for (const e of evidence) {
    if (e.type === "network") return evidenceKeyForRequest(e.requestUrl);
    if (e.type === "console") return normalizeEvidenceText(e.text);
    if (e.type === "metric") return e.name;
  }
  return "";
}

/** Selector without positional parts, so list items of the same kind share one signature. */
function looseSelector(selector: string): string {
  return stabilizeSelector(selector);
}

/** What issues must have in common to be proposed as one root cause. */
export function groupSignature(issue: Pick<Issue, "ruleId" | "evidence">): string {
  // An axe rule across pages: the same component usually causes it everywhere.
  if (issue.ruleId.startsWith("a11y.axe.")) return `${issue.ruleId}|axe|`;
  const net = issue.evidence.find((e) => e.type === "network");
  if (net) return `${issue.ruleId}|net|${evidenceKeyForRequest(net.requestUrl)}`;
  const con = issue.evidence.find((e) => e.type === "console");
  if (con) return `${issue.ruleId}|console|${normalizeEvidenceText(con.text)}`;
  const dom = issue.evidence.find((e) => e.type === "dom");
  if (dom) return `${issue.ruleId}|dom|${looseSelector(dom.selector)}`;
  const metric = issue.evidence.find((e) => e.type === "metric");
  return `${issue.ruleId}|metric|${metric?.name ?? ""}`;
}

/**
 * Same problem seen in several viewports becomes one issue (`viewport: "all"`).
 * Identity = fingerprint (rule + page + element + evidence), see core/fingerprint.
 */
export function fingerprintDraft(draft: IssueDraft): string {
  const aggregated = draft.aggregateKey !== undefined;
  return computeFingerprint({
    ruleId: draft.ruleId,
    pageUrl: draft.pageUrl,
    elementKey: aggregated ? draft.aggregateKey : elementKeyOf(draft.evidence),
    evidenceKey: aggregated ? "" : evidenceKeyOf(draft.evidence),
  });
}

function mergeDrafts(drafts: IssueDraft[]): { draft: IssueDraft; fingerprint: string }[] {
  const byFingerprint = new Map<string, IssueDraft>();
  for (const draft of drafts) {
    const fingerprint = fingerprintDraft(draft);
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, { ...draft });
    } else if (existing.viewport !== draft.viewport) {
      existing.viewport = "all" as Viewport;
    }
  }
  return [...byFingerprint.entries()].map(([fingerprint, draft]) => ({ draft, fingerprint }));
}

export function buildGroups(issues: Issue[], runId: string): IssueGroup[] {
  const buckets = new Map<string, Issue[]>();
  for (const issue of issues) {
    const signature = groupSignature(issue);
    buckets.set(signature, [...(buckets.get(signature) ?? []), issue]);
  }

  const groups: IssueGroup[] = [];
  for (const [signature, members] of buckets) {
    const pages = new Set(members.map((m) => m.pageUrl));
    if (members.length < 2 || pages.size < 2) continue;
    const group: IssueGroup = {
      id: `g_${computeFingerprint({ ruleId: signature, pageUrl: "/" })}`,
      runId,
      ruleId: members[0]!.ruleId,
      signature,
      hypothesis: true,
      confidence: pages.size >= 5 ? 0.8 : 0.6,
      issueIds: members.map((m) => m.id),
      affectedPages: pages.size,
    };
    for (const m of members) m.groupId = group.id;
    groups.push(group);
  }
  return groups.sort((a, b) => b.affectedPages - a.affectedPages);
}

export function analyze(scan: ScanResult, options: AnalyzeOptions): AnalyzeResult {
  const now = options.now ?? new Date().toISOString();
  const site: SiteContext = { scan, check: (url) => scan.linkChecks[url] };

  let drafts = [...scan.pages.flatMap((p) => pageRules(p, site)), ...siteRules(scan.pages, site)];
  if (options.categories) {
    const allowed = new Set(options.categories);
    drafts = drafts.filter((d) => allowed.has(d.category));
  }

  const issues: Issue[] = mergeDrafts(drafts).map(({ draft, fingerprint }) => {
    const status = draft.verdict === "unverified" ? "unverified" : "new";
    return {
      id: randomUUID(),
      runId: options.runId,
      ruleId: draft.ruleId,
      category: draft.category,
      pageUrl: draft.pageUrl,
      viewport: draft.viewport,
      title: draft.title,
      severity: draft.severity,
      confidence: draft.confidence,
      verdict: draft.verdict,
      unverifiedReason: draft.unverifiedReason,
      status,
      evidence: draft.evidence,
      explanation: draft.explanation,
      fix: draft.fix,
      fingerprint,
      firstSeenRunId: options.runId,
      lastSeenRunId: options.runId,
      statusHistory: [{ from: null, to: status, runId: options.runId, at: now }],
    };
  });

  return { issues, groups: buildGroups(issues, options.runId) };
}
