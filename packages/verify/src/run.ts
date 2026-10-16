import type { Issue, Verification } from "@webdoctor/core";
import type { Store } from "@webdoctor/storage";
import { applyVerification, sampleGroupMembers } from "./apply";
import { verifyIssues } from "./verify";
import type { VerifyOptions } from "./verify";

export interface VerifyRunResult {
  results: Verification[];
  /** The checked issues with their new status/history (already saved). */
  issues: Issue[];
}

export class VerifyInputError extends Error {}

/** Re-checks issues of a saved run, then persists results and any status changes. */
export async function verifyAndSave(
  store: Store,
  runId: string,
  issueIds: string[],
  options: VerifyOptions = {},
): Promise<VerifyRunResult> {
  const report = store.getReport(runId);
  if (!report) throw new VerifyInputError(`run ${runId} not found`);

  const issues = issueIds.map((id) => {
    const issue = report.issues.find((i) => i.id === id);
    if (!issue) throw new VerifyInputError(`issue ${id} not found in run ${runId}`);
    return issue;
  });

  const results = await verifyIssues(issues, options);
  const byId = new Map(results.map((r) => [r.issueId, r]));
  const updated = issues.map((i) => applyVerification(i, byId.get(i.id)!));

  store.updateIssues(updated.filter((u, idx) => u !== issues[idx]));
  store.addVerifications(runId, results);
  return { results, issues: updated };
}

export interface GroupVerifyResult extends VerifyRunResult {
  /** Pages that were actually re-checked and pages the group spans. */
  checkedPages: number;
  totalPages: number;
}

/** Re-checks up to `limit` pages of a root-cause group (one issue per page). */
export async function verifyGroupAndSave(
  store: Store,
  runId: string,
  groupId: string,
  limit = 5,
  options: VerifyOptions = {},
): Promise<GroupVerifyResult> {
  const report = store.getReport(runId);
  if (!report) throw new VerifyInputError(`run ${runId} not found`);
  const group = report.groups.find((g) => g.id === groupId);
  if (!group) throw new VerifyInputError(`group ${groupId} not found in run ${runId}`);

  const members = report.issues.filter((i) => i.groupId === groupId);
  const sample = sampleGroupMembers(members, Math.min(Math.max(limit, 1), 10));
  const result = await verifyAndSave(
    store,
    runId,
    sample.map((i) => i.id),
    options,
  );
  return {
    ...result,
    checkedPages: sample.length,
    totalPages: new Set(members.map((m) => m.pageUrl)).size,
  };
}
