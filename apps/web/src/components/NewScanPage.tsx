import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { scanClient } from "../lib/api";
import type { ScanClient, ScanJob } from "../lib/api";
import { runHash } from "../lib/route";
import { t } from "../lib/strings";

/** "example.com" is what people type; the scanner needs a full address. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return value;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

const TERMINAL = new Set<ScanJob["status"]>(["completed", "failed", "canceled"]);

interface Props {
  client?: ScanClient;
  /** How often the running scan is polled (ms). */
  pollMs?: number;
}

function Progress({ job }: { job: ScanJob }) {
  const text =
    job.status === "queued"
      ? "Waiting for the scan before this one to finish…"
      : job.phase === "checking-links"
        ? `Checking ${job.linkTargets ?? ""} links and finishing the analysis…`
        : `Scanning… ${job.pagesDone} ${job.pagesDone === 1 ? "page" : "pages"} done`;
  return (
    <div className="scan-progress" role="status" aria-live="polite">
      <strong>{text}</strong>
      {job.lastUrl && job.status === "running" && job.phase === "crawling" && (
        <p className="muted small mono">{job.lastUrl}</p>
      )}
      {job.skipped > 0 && (
        <p className="muted small">
          {job.skipped} addresses skipped (dead links, other sites, robots.txt).
        </p>
      )}
    </div>
  );
}

export function NewScanPage({ client = scanClient, pollMs = 1000 }: Props) {
  const [address, setAddress] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(3);
  const [desktop, setDesktop] = useState(true);
  const [mobile, setMobile] = useState(true);
  const [respectRobots, setRespectRobots] = useState(true);
  const [job, setJob] = useState<ScanJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Poll the running scan until it ends.
  const jobId = job?.id;
  const finished = job ? TERMINAL.has(job.status) : true;
  useEffect(() => {
    if (!jobId || finished) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await client.get(jobId);
        if (alive.current) setJob(next);
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
    }, pollMs);
    return () => window.clearTimeout(timer);
  }, [jobId, finished, job, client, pollMs]);

  const viewports = [
    ...(desktop ? (["desktop"] as const) : []),
    ...(mobile ? (["mobile"] as const) : []),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (viewports.length === 0) return setError("Choose at least one viewport.");
    setBusy(true);
    try {
      const started = await client.start({
        url: normalizeAddress(address),
        maxPages,
        maxDepth,
        viewports,
        respectRobots,
      });
      if (alive.current) setJob(started);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const stop = async () => {
    if (!job) return;
    try {
      setJob(await client.cancel(job.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const active = job && !finished;

  return (
    <div className="page-pad new-scan">
      <h1>{t.newScan}</h1>

      {!active && !(job && finished) && (
        <form onSubmit={submit} className="scan-form">
          <label className="field">
            <span>{t.scanUrlLabel}</span>
            <input
              className="input input-big"
              type="text"
              inputMode="url"
              autoFocus
              required
              placeholder="https://your-site.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <span className="muted small">{t.scanUrlHint}</span>
          </label>

          <details className="fold">
            <summary>{t.scanOptions}</summary>
            <div className="options-grid">
              <label className="field">
                <span>{t.scanMaxPages}</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>{t.scanDepth}</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={6}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                />
              </label>
              <fieldset className="field">
                <legend>{t.viewport}</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={desktop}
                    onChange={(e) => setDesktop(e.target.checked)}
                  />
                  {t.desktop}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mobile}
                    onChange={(e) => setMobile(e.target.checked)}
                  />
                  {t.mobile}
                </label>
              </fieldset>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={respectRobots}
                onChange={(e) => setRespectRobots(e.target.checked)}
              />
              {t.scanRobots}
            </label>
          </details>

          {error && (
            <p className="notice warn" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-big" disabled={busy}>
            {busy ? "Starting…" : t.scanStart}
          </button>
        </form>
      )}

      {active && job && (
        <section className="scan-card">
          <p className="mono small">{job.url}</p>
          <Progress job={job} />
          {error && (
            <p className="notice warn" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn" onClick={stop}>
            {t.scanCancel}
          </button>
        </section>
      )}

      {job && finished && (
        <section className="scan-card" role="status">
          {job.status === "failed" ? (
            <>
              <strong>The scan could not run.</strong>
              <p role="alert">{job.error}</p>
            </>
          ) : (
            <>
              <strong>
                {job.status === "canceled" ? "Stopped. " : "Done. "}
                {job.pagesDone} {job.pagesDone === 1 ? "page" : "pages"} scanned,{" "}
                {job.failCount ?? 0} {job.failCount === 1 ? "problem" : "problems"} found.
              </strong>
              {job.partial && (
                <p className="muted">
                  This result is partial: not every page was scanned, so more problems may exist.
                </p>
              )}
              {job.runId && (
                <p>
                  <a className="btn btn-primary" href={runHash(job.runId)}>
                    {t.scanOpen}
                  </a>
                </p>
              )}
            </>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setJob(null);
              setError(null);
            }}
          >
            {t.scanAgain}
          </button>
        </section>
      )}
    </div>
  );
}
