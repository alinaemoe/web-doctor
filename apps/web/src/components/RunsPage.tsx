import type { RunListItem } from "../lib/api";
import { runHash } from "../lib/route";
import { t } from "../lib/strings";

export function RunsPage({ runs }: { runs: RunListItem[] }) {
  if (runs.length === 0) {
    return (
      <p className="empty page-pad">
        {t.noRuns} Or <a href="#/new">start a scan here</a>.
      </p>
    );
  }
  return (
    <div className="page-pad">
      <h1>{t.runs}</h1>
      <table className="runs">
        <thead>
          <tr>
            <th scope="col">Site</th>
            <th scope="col">Started</th>
            <th scope="col">Failing</th>
            <th scope="col">{t.unverified}</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <a href={runHash(r.id)}>{r.startUrl}</a>
              </th>
              <td>{new Date(r.startedAt).toLocaleString()}</td>
              <td>{r.failCount}</td>
              <td>{r.unverifiedCount}</td>
              <td>{r.partial ? "partial" : r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
