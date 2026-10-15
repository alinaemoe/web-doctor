import type { Issue } from "@webdoctor/core";
import type { ExpectedIssue } from "./expected";

export interface MatchResult {
  /** Expectations (one per rule × page) that were satisfied. */
  found: { ruleId: string; path: string }[];
  /** Expectations the scanner failed to report. */
  missing: { ruleId: string; path: string; note: string }[];
  /** Reported issues that no expectation covers (not necessarily wrong: review them). */
  unexpected: Issue[];
  /** found / (found + missing); 1 when nothing was expected. */
  recall: number;
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/**
 * Compares scanner output with the Broken Shop manifest.
 * @param crawledPaths paths of the HTML pages the scan visited; expands `"all-crawled"`.
 */
export function matchExpected(
  issues: Issue[],
  expected: ExpectedIssue[],
  crawledPaths: string[],
): MatchResult {
  const matchedIssueIds = new Set<string>();
  const found: MatchResult["found"] = [];
  const missing: MatchResult["missing"] = [];

  for (const exp of expected) {
    const paths = exp.pages === "all-crawled" ? crawledPaths : exp.pages;
    for (const path of paths) {
      const hits = issues.filter(
        (i) =>
          i.ruleId === exp.ruleId &&
          pathOf(i.pageUrl) === path &&
          i.verdict === exp.verdict &&
          (exp.viewport === "all" || i.viewport === exp.viewport || i.viewport === "all"),
      );
      if (hits.length === 0) {
        missing.push({ ruleId: exp.ruleId, path, note: exp.note });
      } else {
        found.push({ ruleId: exp.ruleId, path });
        for (const h of hits) matchedIssueIds.add(h.id);
      }
    }
  }

  const total = found.length + missing.length;
  return {
    found,
    missing,
    unexpected: issues.filter((i) => !matchedIssueIds.has(i.id)),
    recall: total === 0 ? 1 : found.length / total,
  };
}
