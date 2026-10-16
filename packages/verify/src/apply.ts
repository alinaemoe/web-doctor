import type { Issue, Status, Verification } from "@webdoctor/core";

/**
 * Turns a verification result into the issue's new state. Only a confirmed fix changes an issue to
 * `fixed`; a failing re-check of an already fixed issue reopens it; `unverified` changes nothing.
 */
export function applyVerification(issue: Issue, v: Verification): Issue {
  if (issue.status === "ignored") return issue;
  let to: Status | null = null;
  if (v.outcome === "verified-fixed" && issue.status !== "fixed") to = "fixed";
  else if (v.outcome === "still-failing" && issue.status === "fixed") to = "reopened";
  if (!to) return issue;

  return {
    ...issue,
    status: to,
    statusHistory: [
      ...issue.statusHistory,
      {
        from: issue.status,
        to,
        runId: issue.runId,
        at: v.checkedAt,
        reason: `Re-verified: ${v.detail}`,
      },
    ],
  };
}

/** One representative issue per page, so a group check does not load the same page twice. */
export function sampleGroupMembers(members: Issue[], limit: number): Issue[] {
  const byPage = new Map<string, Issue>();
  // unresolved issues first: re-checking what is already fixed is the least useful
  const ordered = [...members].sort(
    (a, b) => Number(a.status === "fixed") - Number(b.status === "fixed"),
  );
  for (const issue of ordered) if (!byPage.has(issue.pageUrl)) byPage.set(issue.pageUrl, issue);
  return [...byPage.values()].slice(0, Math.max(1, limit));
}
