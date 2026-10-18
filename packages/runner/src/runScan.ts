import type { NetworkGuard } from "@webdoctor/netguard";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReportSchema, SCHEMA_VERSION, applyHistory, summarizeRun } from "@webdoctor/core";
import type { Category, Report, ScanResult, ScanViewport, Severity } from "@webdoctor/core";
import { analyze } from "@webdoctor/rules";
import { FsArtifactStore, SCANNER_VERSION, scan } from "@webdoctor/scanner";
import type { ScanProgress } from "@webdoctor/scanner";
import { openStore } from "@webdoctor/storage";
import { toFixPrompt } from "./fixPrompt";
import { toCsv, toHtml } from "./reports";

export type ReportFormat = "json" | "csv" | "html" | "md";

export interface RunScanOptions {
  url: string;
  /** Output directory (default `./.webdoctor`). */
  outDir?: string;
  maxPages?: number;
  maxDepth?: number;
  viewports?: ScanViewport[];
  categories?: Category[];
  formats?: ReportFormat[];
  respectRobots?: boolean;
  timeoutMs?: number;
  /** Cap on distinct external addresses whose links get checked (default 100). */
  maxExternalLinks?: number;
  signal?: AbortSignal;
  /** Public mode: the scan may only reach public addresses, through this guard. */
  guard?: NetworkGuard;
  /** Public mode: who the run belongs to (history is built from the same owner's runs only). */
  owner?: string;
  onProgress?: (e: ScanProgress) => void;
}

export interface RunScanResult {
  report: Report;
  runDir: string;
  files: string[];
}

export const ALL_CATEGORIES: Category[] = ["links-resources", "accessibility", "seo", "runtime"];
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

export async function runScan(options: RunScanOptions): Promise<RunScanResult> {
  const outDir = resolve(options.outDir ?? ".webdoctor");
  const runId = `run-${stamp()}-${randomBytes(2).toString("hex")}`;
  const runDir = join(outDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const viewports = options.viewports?.length
    ? options.viewports
    : (["desktop", "mobile"] as const);
  const categories = options.categories?.length ? options.categories : ALL_CATEGORIES;
  const artifacts = new FsArtifactStore(runDir);

  const result = await scan({
    startUrl: options.url,
    artifacts,
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    viewports: [...viewports],
    respectRobots: options.respectRobots,
    timeoutMs: options.timeoutMs,
    maxExternalLinks: options.maxExternalLinks ?? 100,
    signal: options.signal,
    guard: options.guard,
    onProgress: options.onProgress,
  });

  const { issues, groups } = analyze(result, { runId, categories });

  const report: Report = ReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: runId,
      status: result.partial ? "completed_with_warnings" : "completed",
      settings: {
        startUrl: result.startUrl,
        maxPages: options.maxPages ?? 50,
        maxDepth: options.maxDepth ?? 3,
        viewports: [...viewports],
        categories,
        respectRobots: options.respectRobots ?? true,
      },
      scannerVersion: SCANNER_VERSION,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      partial: result.partial,
      stopReason: result.stopReason,
      sitemapUrls: result.sitemap.locs.length,
      externalLinksCapped: result.externalLinksCapped,
    },
    pages: result.pages.map((p) => ({
      url: p.url,
      finalUrl: p.finalUrl,
      status: p.status,
      depth: p.depth,
      viewport: p.viewport,
      title: p.title,
      screenshotKey: p.screenshotKey,
      screenshotTruncated: p.screenshotTruncated,
    })),
    issues,
    groups,
  });

  const withHistory = withPreviousRun(report, outDir, undefined, options.owner);

  return persistRun({
    report: withHistory,
    result,
    outDir,
    runDir,
    artifacts,
    formats: options.formats,
    owner: options.owner,
  });
}

/**
 * Compares a fresh report with the previous run of the same site (if any): problems found again
 * keep their history, problems that disappeared from a page that was scanned again become fixed,
 * and problems on pages that were not looked at again are carried over as "not rechecked".
 */
export function withPreviousRun(
  report: Report,
  outDir: string,
  beforeStartedAt?: string,
  owner?: string,
): Report {
  const store = openStore(join(outDir, "webdoctor.db"));
  let previous: Report | undefined;
  let previousId: string | undefined;
  try {
    previousId = store.findPreviousRun(
      report.run.settings.startUrl,
      beforeStartedAt ?? report.run.startedAt,
      owner,
    )?.id;
    previous = previousId ? store.getReport(previousId) : undefined;
  } finally {
    store.close();
  }
  const issues = applyHistory(report, previous);
  return {
    ...report,
    run: {
      ...report.run,
      previousRunId: previousId,
      summary: summarizeRun(issues, report.run.id),
    },
    issues,
  };
}

export interface PersistOptions {
  report: Report;
  result: ScanResult;
  outDir: string;
  runDir: string;
  artifacts: FsArtifactStore;
  formats?: ReportFormat[];
  owner?: string;
}

/** Writes the snapshots and reports of a finished run and saves it in the database. */
export async function persistRun(o: PersistOptions): Promise<RunScanResult> {
  const { report, result, outDir, runDir, artifacts } = o;
  const files: string[] = [];
  const write = (name: string, data: string) => {
    const path = join(runDir, name);
    writeFileSync(path, data);
    files.push(path);
  };

  // Raw snapshots stay on disk so a run can be re-analyzed with newer rules and single issues can
  // be re-verified. One JSON line per page: a scan of thousands of pages must not become one
  // giant string.
  const { pages: snapshots, ...scanMeta } = result;
  write("scan.json", JSON.stringify(scanMeta));
  const pagesFile = join(runDir, "pages.ndjson");
  const fd = openSync(pagesFile, "w");
  try {
    for (const page of snapshots) writeSync(fd, JSON.stringify(page) + "\n");
  } finally {
    closeSync(fd);
  }
  files.push(pagesFile);

  const formats = o.formats?.length ? o.formats : (["json", "csv", "html", "md"] as const);
  if (formats.includes("json")) write("report.json", JSON.stringify(report, null, 2));
  if (formats.includes("csv")) write("issues.csv", toCsv(report.issues));
  if (formats.includes("md")) write("fix-prompt.md", toFixPrompt(report));
  if (formats.includes("html")) {
    const cache = new Map<string, Uint8Array>();
    const shots = new Map(
      await Promise.all(
        report.pages
          .filter((p) => p.screenshotKey)
          .map(
            async (p) =>
              [
                p.screenshotKey!,
                await artifacts.read(p.screenshotKey!).catch(() => undefined),
              ] as const,
          ),
      ),
    );
    for (const [k, v] of shots) if (v) cache.set(k, v);
    write("report.html", toHtml(report, { screenshot: (key) => cache.get(key) }));
  }

  const store = openStore(join(outDir, "webdoctor.db"));
  try {
    store.saveReport(report, o.owner);
  } finally {
    store.close();
  }

  return { report, runDir, files };
}
