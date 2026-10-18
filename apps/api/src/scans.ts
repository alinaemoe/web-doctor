import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runScan } from "@webdoctor/runner";
import type { RunScanOptions, RunScanResult } from "@webdoctor/runner";

/** Upper bound for one scan started from the UI. */
export const MAX_SCAN_PAGES = 5000;

/**
 * Time budget for a scan: about 4 s per page and viewport (the crawl is parallel but pages vary),
 * at least 10 minutes and at most 4 hours, so a runaway scan cannot go on forever.
 */
export function scanTimeoutMs(maxPages: number, viewports: number): number {
  const ms = maxPages * viewports * 4000;
  return Math.min(4 * 3600_000, Math.max(600_000, ms));
}

/** Body of `POST /api/scans`. Everything but `url` is optional. */
export const StartScanSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "Enter a full http(s) address, for example https://example.com"),
  maxPages: z.number().int().min(1).max(MAX_SCAN_PAGES).default(50),
  maxDepth: z.number().int().min(0).max(6).default(3),
  viewports: z
    .array(z.enum(["desktop", "mobile"]))
    .min(1)
    .max(2)
    .default(["desktop", "mobile"]),
  respectRobots: z.boolean().default(true),
});
export type StartScanInput = z.infer<typeof StartScanSchema>;

export type ScanJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type ScanPhase = "queued" | "crawling" | "checking-links" | "saving" | "done";

export interface ScanJob {
  id: string;
  url: string;
  status: ScanJobStatus;
  phase: ScanPhase;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Distinct pages loaded so far. */
  pagesDone: number;
  /** URLs that were not scanned (dead links, robots.txt, other sites). */
  skipped: number;
  lastUrl?: string;
  /** The most recent pages, newest first (for a live feed). */
  recent: string[];
  /** Pages found and waiting to be scanned. */
  queued: number;
  /** Link targets being checked in the last phase. */
  linkTargets?: number;
  runId?: string;
  partial?: boolean;
  failCount?: number;
  error?: string;
}

export type ScanFn = (options: RunScanOptions) => Promise<RunScanResult>;

interface Internal {
  job: ScanJob;
  input: StartScanInput;
  controller: AbortController;
  pages: Set<string>;
}

const MAX_KEPT_JOBS = 50;

/**
 * Runs scans started from the UI, one at a time (each uses a real browser). Jobs live in memory:
 * the finished run itself is saved by `runScan`, so nothing is lost when the server restarts.
 */
export class ScanManager {
  private readonly jobs = new Map<string, Internal>();
  private readonly waiting: string[] = [];
  private running = false;

  constructor(
    private readonly options: {
      dataDir: string;
      run?: ScanFn;
      /** Scans allowed to wait behind the running one. */
      maxQueued?: number;
    },
  ) {}

  start(input: StartScanInput): ScanJob | "busy" {
    if (this.waiting.length >= (this.options.maxQueued ?? 2)) return "busy";
    const id = randomUUID();
    const internal: Internal = {
      job: {
        id,
        url: input.url,
        status: "queued",
        phase: "queued",
        createdAt: new Date().toISOString(),
        pagesDone: 0,
        skipped: 0,
        recent: [],
        queued: 0,
      },
      input,
      controller: new AbortController(),
      pages: new Set(),
    };
    this.jobs.set(id, internal);
    this.waiting.push(id);
    this.prune();
    void this.pump();
    return { ...internal.job };
  }

  get(id: string): ScanJob | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.job } : undefined;
  }

  list(): ScanJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j.job })).reverse();
  }

  /** A queued scan is dropped; a running one stops gracefully and keeps what it has found. */
  cancel(id: string): ScanJob | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.job.status === "queued") {
      this.waiting.splice(this.waiting.indexOf(id), 1);
      j.job.status = "canceled";
      j.job.phase = "done";
      j.job.finishedAt = new Date().toISOString();
    } else if (j.job.status === "running") {
      j.controller.abort();
    }
    return { ...j.job };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.waiting.shift();
    if (!id) return;
    const j = this.jobs.get(id);
    if (!j) return void this.pump();

    this.running = true;
    j.job.status = "running";
    j.job.phase = "crawling";
    j.job.startedAt = new Date().toISOString();

    try {
      const run = this.options.run ?? runScan;
      const result = await run({
        url: j.input.url,
        outDir: this.options.dataDir,
        maxPages: j.input.maxPages,
        maxDepth: j.input.maxDepth,
        viewports: j.input.viewports,
        respectRobots: j.input.respectRobots,
        timeoutMs: scanTimeoutMs(j.input.maxPages, j.input.viewports.length),
        signal: j.controller.signal,
        onProgress: (e) => {
          if (e.type === "page") {
            if (!j.pages.has(e.url)) j.job.recent = [e.url, ...j.job.recent].slice(0, 8);
            j.pages.add(e.url);
            j.job.pagesDone = j.pages.size;
            j.job.lastUrl = e.url;
            j.job.queued = e.queued;
          } else if (e.type === "skipped") {
            j.job.skipped++;
          } else if (e.type === "links") {
            j.job.phase = "checking-links";
            j.job.linkTargets = e.total;
          }
        },
      });
      j.job.runId = result.report.run.id;
      j.job.partial = result.report.run.partial;
      j.job.failCount =
        result.report.run.summary?.failing ??
        result.report.issues.filter((i) => i.verdict === "fail").length;
      j.job.status = j.controller.signal.aborted ? "canceled" : "completed";
    } catch (error) {
      j.job.status = "failed";
      j.job.error = (error as Error).message;
    } finally {
      j.job.phase = "done";
      j.job.finishedAt = new Date().toISOString();
      this.running = false;
      void this.pump();
    }
  }

  private prune(): void {
    if (this.jobs.size <= MAX_KEPT_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_KEPT_JOBS) break;
      if (j.job.status !== "queued" && j.job.status !== "running") this.jobs.delete(id);
    }
  }
}
