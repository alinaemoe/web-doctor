import { useMemo, useState } from "react";
import type { Issue, Report, Verification } from "@webdoctor/core/shared";
import { verifyGroup, verifyIssue } from "../lib/api";
import type { VerifyResponse } from "../lib/api";
import type { VerifyUi } from "../lib/verifyUi";
import { Inspector } from "./Inspector";

export interface VerifyClient {
  verifyIssue: (runId: string, issueId: string) => Promise<VerifyResponse>;
  verifyGroup: (runId: string, groupId: string) => Promise<VerifyResponse>;
}

const realClient: VerifyClient = { verifyIssue, verifyGroup };

interface Props {
  initialReport: Report;
  initialVerifications: Verification[];
  initialIssueId?: string;
  onIssueChange?: (issueId: string | undefined) => void;
  /** Test seam. */
  client?: VerifyClient;
}

function summarizeGroupCheck(r: VerifyResponse): string {
  const count = (o: Verification["outcome"]) => r.results.filter((v) => v.outcome === o).length;
  const parts = [`${count("verified-fixed")} verified fixed`];
  if (count("still-failing")) parts.push(`${count("still-failing")} still failing`);
  if (count("unverified")) parts.push(`${count("unverified")} couldn't be verified`);
  const notChecked = (r.totalPages ?? 0) - (r.checkedPages ?? 0);
  return `Checked ${r.checkedPages} of ${r.totalPages} pages of the group: ${parts.join(", ")}.${
    notChecked > 0 ? ` The other ${notChecked} pages were not checked.` : ""
  }`;
}

/** Owns the mutable parts of a run (issue statuses, verification results) around the Inspector. */
export function RunWorkspace({
  initialReport,
  initialVerifications,
  initialIssueId,
  onIssueChange,
  client = realClient,
}: Props) {
  const [report, setReport] = useState(initialReport);
  const [verifications, setVerifications] = useState(initialVerifications);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [groupRuns, setGroupRuns] = useState<VerifyUi["groupRuns"]>({});
  const [notice, setNotice] = useState<string | null>(null);

  const apply = (updated: Issue[], results: Verification[]) => {
    const byId = new Map(updated.map((i) => [i.id, i]));
    setReport((r) => ({ ...r, issues: r.issues.map((i) => byId.get(i.id) ?? i) }));
    setVerifications((v) => [...v, ...results]);
  };

  const track = async (key: string, job: () => Promise<VerifyResponse>) => {
    setRunning((s) => new Set(s).add(key));
    setError(null);
    try {
      const response = await job();
      apply(response.issues, response.results);
      return response;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const verify: VerifyUi = useMemo(
    () => ({
      running,
      error,
      verifications,
      groupRuns,
      onIssue: (issueId) =>
        void track(`issue:${issueId}`, () => client.verifyIssue(report.run.id, issueId)),
      onGroup: (groupId) =>
        void track(`group:${groupId}`, () => client.verifyGroup(report.run.id, groupId)).then(
          (r) => {
            if (r?.checkedPages === undefined || r.totalPages === undefined) return;
            setGroupRuns((g) => ({
              ...g,
              [groupId]: { checkedPages: r.checkedPages!, totalPages: r.totalPages! },
            }));
            setNotice(summarizeGroupCheck(r));
          },
        ),
    }),
    // `track` only closes over setters and `client`; the run id never changes for a workspace
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, error, verifications, groupRuns, report.run.id, client],
  );

  return (
    <>
      {notice && (
        <p className="banner" role="status">
          <span>{notice}</span>
          <button type="button" className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      <Inspector
        report={report}
        initialIssueId={initialIssueId}
        onIssueChange={onIssueChange}
        verify={verify}
      />
    </>
  );
}
