import type { Run } from "@webdoctor/core/shared";
import { runHash } from "../lib/route";

/** One line above the inspector: how this run compares with the one before it. */
export function HistoryStrip({ run }: { run: Run }) {
  if (!run.previousRunId || !run.summary) return null;
  const s = run.summary;
  return (
    <p className="history-strip" aria-label="Changes since the previous run">
      <strong>Since the previous scan:</strong>
      <span className="chip-delta bad">+{s.new} new</span>
      <span className="chip-delta ok">−{s.fixedSinceLast} fixed</span>
      {s.reopened > 0 && <span className="chip-delta bad">↺ {s.reopened} back</span>}
      {s.notRechecked > 0 && (
        <span
          className="chip-delta"
          title="Known from earlier runs; this run did not look at their pages again, so they are not counted as fixed"
        >
          {s.notRechecked} not rechecked
        </span>
      )}
      <a href={runHash(run.previousRunId)}>Open the previous run</a>
    </p>
  );
}
