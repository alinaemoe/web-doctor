import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReportSchema, SCHEMA_VERSION } from "@webdoctor/core";
import type { Category, Report, ScanViewport, Severity } from "@webdoctor/core";
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

const stamp = () =>
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

  const files: string[] = [];
  const write = (name: string, data: string) => {
    const path = join(runDir, name);
    writeFileSync(path, data);
    files.push(path);
  };

  // Raw snapshots stay on disk so single issues can be re-verified later (Verify Fix).
  write("scan.json", JSON.stringify(result));

  const formats = options.formats?.length
    ? options.formats
    : (["json", "csv", "html", "md"] as const);
  if (formats.includes("json")) write("report.json", JSON.stringify(report, null, 2));
  if (formats.includes("csv")) write("issues.csv", toCsv(report.issues));
  if (formats.includes("md")) write("fix-prompt.md", toFixPrompt(report));
  if (formats.includes("html")) {
    const cache = new Map<string, Uint8Array>();
    const shots = new Map(
      await Promise.all(
        report.pages
          .filter((p) => p.screenshotKey)
          .map(async (p) => [p.screenshotKey!, await artifacts.read(p.screenshotKey!)] as const),
      ),
    );
    for (const [k, v] of shots) cache.set(k, v);
    write("report.html", toHtml(report, { screenshot: (key) => cache.get(key) }));
  }

  const store = openStore(join(outDir, "webdoctor.db"));
  try {
    store.saveReport(report);
  } finally {
    store.close();
  }

  return { report, runDir, files };
}
