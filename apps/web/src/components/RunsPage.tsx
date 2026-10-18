import type { RunListItem } from "../lib/api";
import { runHash } from "../lib/route";
import { t } from "../lib/strings";
import { Sparkline } from "./Sparkline";

/** What changed since the run before: the Regression Radar chips. */
export function Delta({ run }: { run: RunListItem }) {
  if (!run.previousRunId) return <span className="muted">first run</span>;
  const s = run.summary;
  return (
    <span className="delta">
      <span className="chip-delta bad" title="Problems seen for the first time">
        +{s.new} new
      </span>
      <span className="chip-delta ok" title="Problems that were fixed since the previous run">
        −{s.fixedSinceLast} fixed
      </span>
      {s.reopened > 0 && (
        <span className="chip-delta bad" title="Problems that were fixed before and are back">
          ↺ {s.reopened} back
        </span>
      )}
      {s.notRechecked > 0 && (
        <span
          className="chip-delta"
          title="Known from earlier runs, but this run did not look at their pages again"
        >
          {s.notRechecked} not rechecked
        </span>
      )}
    </span>
  );
}

function SiteHistory({ site, runs }: { site: string; runs: RunListItem[] }) {
  // runs arrive newest first; the trend reads oldest to newest
  const trend = [...runs].reverse().map((r) => r.summary.failing);
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  return (
    <section className="site-history" aria-label={`History of ${site}`}>
      <header className="site-head">
        <h2>{site}</h2>
        {runs.length > 1 && (
          <Sparkline
            values={trend}
            label={`Open problems over ${runs.length} runs: from ${first} to ${last}`}
          />
        )}
        <span className="muted small">
          {runs.length} {runs.length === 1 ? "run" : "runs"}
          {runs.length > 1 && ` · ${first} → ${last} open problems`}
        </span>
      </header>
      <table className="runs">
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Open</th>
            <th scope="col">Since the previous run</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <a href={runHash(r.id)}>{new Date(r.startedAt).toLocaleString()}</a>
              </th>
              <td>
                {r.summary.failing}
                {r.summary.unverified > 0 && (
                  <span className="muted small"> + {r.summary.unverified} unverified</span>
                )}
              </td>
              <td>
                <Delta run={r} />
              </td>
              <td>
                {r.partial ? "partial" : r.status}
                {r.reanalyzedFrom && <span className="muted small"> · re-analyzed</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function RunsPage({ runs }: { runs: RunListItem[] }) {
  if (runs.length === 0) {
    return (
      <p className="empty page-pad">
        {t.noRuns} Or <a href="#/new">start a scan here</a>.
      </p>
    );
  }
  const bySite = new Map<string, RunListItem[]>();
  for (const r of runs) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);

  return (
    <div className="page-pad">
      <h1>{t.runs}</h1>
      {[...bySite.entries()].map(([site, list]) => (
        <SiteHistory key={site} site={site} runs={list} />
      ))}
    </div>
  );
}
