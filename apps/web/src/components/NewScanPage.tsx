import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { scanClient } from "../lib/api";
import type { ScanClient, ScanJob } from "../lib/api";
import { runHash } from "../lib/route";
import { BIG_SCAN_PAGES, SCAN_PRESETS, formatElapsed, linesFor } from "../lib/scanFun";
import { t } from "../lib/strings";

/** "example.com" is what people type; the scanner needs a full address. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return value;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

const TERMINAL = new Set<ScanJob["status"]>(["completed", "failed", "canceled"]);
const ADDRESS_KEY = "webdoctor.lastAddress";

function readLastAddress(): string {
  try {
    return window.localStorage.getItem(ADDRESS_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberAddress(value: string): void {
  try {
    window.localStorage.setItem(ADDRESS_KEY, value);
  } catch {
    // private mode: the address just won't be remembered
  }
}

interface Props {
  client?: ScanClient;
  /** How often the running scan is polled (ms). */
  pollMs?: number;
  /** How often the fun line changes (ms). */
  funMs?: number;
}

/** A heartbeat line: a small joke that doubles as a "still alive" indicator. */
function Heartbeat() {
  return (
    <svg className="ecg" viewBox="0 0 300 40" aria-hidden="true" focusable="false">
      <path d="M0 20 H70 L80 20 L90 4 L102 36 L112 20 H170 L180 20 L190 8 L202 32 L212 20 H300" />
    </svg>
  );
}

/** Rotating, purely decorative lines. Not announced to assistive technology. */
function FunLine({ phase, everyMs }: { phase: ScanJob["phase"]; everyMs: number }) {
  const lines = useMemo(() => linesFor(phase), [phase]);
  const [index, setIndex] = useState(() => Math.floor(Math.random() * lines.length));
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % lines.length), everyMs);
    return () => window.clearInterval(timer);
  }, [lines, everyMs]);
  return (
    <p className="fun-line" aria-hidden="true" key={index} data-testid="fun-line">
      {lines[index % lines.length]}
    </p>
  );
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function LiveScan({
  job,
  funMs,
  onStop,
  error,
}: {
  job: ScanJob;
  funMs: number;
  onStop: () => void;
  error: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const started = job.startedAt ? Date.parse(job.startedAt) : now;
  const elapsed = now - started;
  const perMin = elapsed > 15_000 ? Math.round(job.pagesDone / (elapsed / 60_000)) : null;
  const checking = job.phase === "checking-links";

  return (
    <section className="scan-live" aria-label="Scan in progress">
      <header className="scan-live-head">
        <div>
          <p className="mono small scan-url">{job.url}</p>
          <div role="status" aria-live="polite">
            <strong>
              {job.status === "queued"
                ? "Waiting for the scan before this one to finish…"
                : checking
                  ? `Checking ${job.linkTargets ?? ""} links and finishing the analysis…`
                  : `Scanning… ${job.pagesDone} ${job.pagesDone === 1 ? "page" : "pages"} done`}
            </strong>
          </div>
        </div>
        <button type="button" className="btn" onClick={onStop}>
          {t.scanCancel}
        </button>
      </header>

      <Heartbeat />

      <div className="stats">
        <Stat value={job.pagesDone} label="pages scanned" />
        <Stat value={job.queued} label="found, waiting" />
        <Stat value={job.skipped} label="skipped" />
        <Stat value={formatElapsed(elapsed)} label="elapsed" />
        {perMin !== null && <Stat value={perMin} label="pages / min" />}
      </div>

      <div className="scan-live-body">
        <FunLine phase={job.phase} everyMs={funMs} />
        {job.recent.length > 0 && !checking && (
          <div className="feed" aria-label="Pages scanned just now">
            <h2 className="feed-title">Just scanned</h2>
            <ul>
              {job.recent.map((url, i) => (
                <li key={url} style={{ opacity: Math.max(0.35, 1 - i * 0.09) }}>
                  {url}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="muted small">
        You can switch to another tab: the tab title shows the progress. Skipped addresses are dead
        links, other sites and pages blocked by robots.txt.
      </p>
      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function NewScanPage({ client = scanClient, pollMs = 1000, funMs = 4000 }: Props) {
  const [address, setAddress] = useState(readLastAddress);
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

  // Progress in the tab title, so the scan can run while the user works elsewhere.
  useEffect(() => {
    if (!job) return;
    const previous = document.title;
    if (!finished) document.title = `(${job.pagesDone}) Scanning · Web Doctor`;
    else if (job.status === "completed")
      document.title = `Done · ${job.failCount ?? 0} problems · Web Doctor`;
    return () => {
      document.title =
        previous.startsWith("(") || previous.startsWith("Done") ? "Web Doctor" : previous;
    };
  }, [job, finished]);

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
      const url = normalizeAddress(address);
      const started = await client.start({ url, maxPages, maxDepth, viewports, respectRobots });
      rememberAddress(address.trim());
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
    <div className={`page-pad new-scan${active ? " is-running" : ""}`}>
      <h1>{t.newScan}</h1>

      {!job && (
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

          <div className="field">
            <span>How much to scan</span>
            <div className="chip-row" role="group" aria-label="How much to scan">
              {SCAN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="chip chip-big"
                  aria-pressed={maxPages === p.pages}
                  title={p.hint}
                  onClick={() => setMaxPages(p.pages)}
                >
                  {p.label} · {p.pages}
                </button>
              ))}
            </div>
            {maxPages > BIG_SCAN_PAGES && (
              <p className="notice" role="note">
                Large scans can take an hour or more and use a lot of memory. Consider turning off
                Mobile under Options to halve the time.
              </p>
            )}
          </div>

          <details className="fold">
            <summary>{t.scanOptions}</summary>
            <div className="options-grid">
              <label className="field">
                <span>{t.scanMaxPages}</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={5000}
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

      {active && job && <LiveScan job={job} funMs={funMs} onStop={stop} error={error} />}

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
