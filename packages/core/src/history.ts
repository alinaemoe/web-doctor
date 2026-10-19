import { randomUUID } from "node:crypto";
import { nextStatus } from "./status";
import { pageKey } from "./url";
import type { ScanViewport } from "./snapshot";
import type { Category, Issue, Report, RunSummary, Status } from "./types";

/**
 * Run history and the Regression Radar (TZ 6.11).
 *
 * Issues are matched between runs by fingerprint. The important rule: an issue that is missing
 * from a new run counts as FIXED only if that run really looked where the issue was (same page, same
 * viewports, same category, link checks not cut short). Otherwise nothing is known and the issue is
 * carried over unchanged ("not rechecked"). A smaller or different sample must never look like a
 * clean bill of health.
 */

export interface RunCoverage {
  /** pageKey -> viewports that were scanned successfully */
  pages: Map<string, Set<ScanViewport>>;
  categories: Set<Category>;
  externalLinksCapped: boolean;
}

export function coverageOf(report: Pick<Report, "run" | "pages">): RunCoverage {
  const pages = new Map<string, Set<ScanViewport>>();
  for (const p of report.pages) {
    // an error page tells nothing about the problems that used to be on it
    if (p.status >= 400) continue;
    const key = pageKey(p.url);
    const set = pages.get(key) ?? new Set<ScanViewport>();
    set.add(p.viewport);
    pages.set(key, set);
  }
  return {
    pages,
    categories: new Set(report.run.settings.categories),
    externalLinksCapped: report.run.externalLinksCapped ?? false,
  };
}

/** Did the run look in the place where this issue was found? */
export function issueCovered(issue: Issue, coverage: RunCoverage): boolean {
  if (!coverage.categories.has(issue.category)) return false;

  if (issue.ruleId.startsWith("seo.sitemap.")) return coverage.pages.size > 0;
  // Only the first N external addresses are checked; a link not re-checked is not a fixed link.
  if (issue.ruleId === "link.external.broken" && coverage.externalLinksCapped) return false;

  const seen = coverage.pages.get(pageKey(issue.pageUrl));
  // "How pages link to each other" does not depend on the viewport: one look at the page is enough
  if (issue.ruleId.startsWith("nav.")) return seen !== undefined && seen.size > 0;

  const needed: ScanViewport[] =
    issue.viewport === "all" ? ["desktop", "mobile"] : [issue.viewport];
  return seen !== undefined && needed.every((v) => seen.has(v));
}

export interface HistoryOptions {
  now?: string;
  newId?: () => string;
}

/**
 * Applies the previous run to the current one and returns the issue list of the current run:
 * - found again:        New -> Open, Fixed -> Reopened (history and first-seen are inherited)
 * - gone, page rechecked: Fixed
 * - gone, not rechecked:  carried over unchanged, with its old `lastSeenRunId` (= stale)
 * - already Fixed/Ignored: carried over so a later return is recognized as Reopened
 * Without a previous run the issues are returned as they are (all new).
 */
export function applyHistory(
  current: Report,
  previous: Report | undefined,
  options: HistoryOptions = {},
): Issue[] {
  if (!previous) return current.issues;

  const runId = current.run.id;
  const now = options.now ?? new Date().toISOString();
  const newId = options.newId ?? randomUUID;
  const coverage = coverageOf(current);
  const previousByFingerprint = new Map(previous.issues.map((i) => [i.fingerprint, i]));
  const seen = new Set<string>();
  const result: Issue[] = [];

  for (const issue of current.issues) {
    seen.add(issue.fingerprint);
    const prev = previousByFingerprint.get(issue.fingerprint);
    if (!prev) {
      result.push(issue);
      continue;
    }
    // an inconclusive check stays "unverified"; it is not a lifecycle state
    const status: Status =
      issue.verdict === "unverified" ? "unverified" : nextStatus(prev.status, "found").status;
    result.push({
      ...issue,
      status,
      firstSeenRunId: prev.firstSeenRunId,
      lastSeenRunId: runId,
      statusHistory: [
        ...prev.statusHistory,
        ...(status !== prev.status
          ? [
              {
                from: prev.status,
                to: status,
                runId,
                at: now,
                reason: prev.status === "fixed" ? "Found again after it was fixed" : undefined,
              },
            ]
          : []),
      ],
    });
  }

  for (const prev of previous.issues) {
    if (seen.has(prev.fingerprint)) continue;

    const carried = { ...prev, id: newId(), runId, groupId: undefined };

    if (prev.status === "fixed" || prev.status === "ignored") {
      result.push(carried);
    } else if (issueCovered(prev, coverage)) {
      result.push({
        ...carried,
        status: "fixed",
        statusHistory: [
          ...prev.statusHistory,
          {
            from: prev.status,
            to: "fixed",
            runId,
            at: now,
            reason: "Not found when the page was scanned again",
          },
        ],
      });
    } else {
      result.push(carried); // not rechecked: lastSeenRunId keeps pointing at the older run
    }
  }

  return result;
}

/** An issue the current run did not look at again (carried over from an earlier run). */
export const isNotRechecked = (issue: Issue, runId: string): boolean =>
  issue.lastSeenRunId !== runId && issue.status !== "fixed" && issue.status !== "ignored";

/** The numbers shown next to a run: what is open, and what changed since the previous run. */
export function summarizeRun(issues: Issue[], runId: string): RunSummary {
  const s: RunSummary = {
    total: issues.length,
    failing: 0,
    unverified: 0,
    fixed: 0,
    new: 0,
    open: 0,
    reopened: 0,
    fixedSinceLast: 0,
    notRechecked: 0,
  };
  for (const i of issues) {
    const stale = isNotRechecked(i, runId);
    if (i.status === "fixed") {
      s.fixed++;
      const last = i.statusHistory.at(-1);
      if (last?.to === "fixed" && last.runId === runId) s.fixedSinceLast++;
      continue;
    }
    if (i.status === "ignored") continue;
    if (stale) {
      s.notRechecked++;
      continue;
    }
    if (i.verdict === "unverified") s.unverified++;
    else s.failing++;
    if (i.status === "new") s.new++;
    else if (i.status === "open") s.open++;
    else if (i.status === "reopened") s.reopened++;
  }
  return s;
}
