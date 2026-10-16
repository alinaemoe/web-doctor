import type { Verification } from "@webdoctor/core/shared";

/** What the details panel needs to offer "Re-verify" and show its outcome. */
export interface VerifyUi {
  /** Keys like `issue:<id>` / `group:<id>` of checks in progress. */
  running: Set<string>;
  error: string | null;
  /** Oldest first. */
  verifications: Verification[];
  /** Coverage of the last group check. */
  groupRuns: Record<string, { checkedPages: number; totalPages: number }>;
  onIssue: (issueId: string) => void;
  onGroup: (groupId: string) => void;
}

export function latestFor(
  verifications: Verification[],
  issueId: string,
): Verification | undefined {
  for (let i = verifications.length - 1; i >= 0; i--) {
    if (verifications[i]!.issueId === issueId) return verifications[i];
  }
  return undefined;
}
