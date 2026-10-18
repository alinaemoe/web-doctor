import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReportSchema, SCHEMA_VERSION } from "@webdoctor/core";
import type { PageSnapshot, Report, ScanResult } from "@webdoctor/core";
import { analyze } from "@webdoctor/rules";
import { FsArtifactStore, SCANNER_VERSION } from "@webdoctor/scanner";
import { openStore } from "@webdoctor/storage";
import { persistRun, stamp, withPreviousRun } from "./runScan";
import type { ReportFormat, RunScanResult } from "./runScan";

export interface ReanalyzeOptions {
  /** Directory with `webdoctor.db` and `runs/` (default `./.webdoctor`). */
  outDir?: string;
  runId: string;
  formats?: ReportFormat[];
}

export class ReanalyzeError extends Error {}

/**
 * Runs the current rules again over the snapshots of a saved run, without loading any page. The
 * result is a new run (the original stays untouched), so rule improvements can be compared with
 * what the old rules said.
 */
export async function reanalyzeRun(options: ReanalyzeOptions): Promise<RunScanResult> {
  const outDir = resolve(options.outDir ?? ".webdoctor");
  const sourceDir = join(outDir, "runs", options.runId);
  const metaFile = join(sourceDir, "scan.json");
  const pagesFile = join(sourceDir, "pages.ndjson");
  if (!existsSync(metaFile) || !existsSync(pagesFile)) {
    throw new ReanalyzeError(
      `run ${options.runId} has no saved page snapshots (scan.json + pages.ndjson); scan again`,
    );
  }

  const store = openStore(join(outDir, "webdoctor.db"));
  let previous: Report | undefined;
  try {
    previous = store.getReport(options.runId);
  } finally {
    store.close();
  }
  if (!previous) throw new ReanalyzeError(`run ${options.runId} not found in the database`);

  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Omit<ScanResult, "pages">;
  const pages = readFileSync(pagesFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PageSnapshot);
  const result: ScanResult = { ...meta, pages };

  const runId = `run-${stamp()}-${randomBytes(2).toString("hex")}`;
  const runDir = join(outDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  // screenshots are shared by key, so the new run can show them too
  if (existsSync(join(sourceDir, "screenshots"))) {
    cpSync(join(sourceDir, "screenshots"), join(runDir, "screenshots"), { recursive: true });
  }

  const { issues, groups } = analyze(result, {
    runId,
    categories: previous.run.settings.categories,
  });
  const report: Report = ReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    run: {
      ...previous.run,
      id: runId,
      previousRunId: undefined,
      summary: undefined,
      reanalyzedFrom: options.runId,
      scannerVersion: SCANNER_VERSION,
      finishedAt: new Date().toISOString(),
    },
    pages: previous.pages,
    issues,
    groups,
  });

  // compare with the run that came before the source run, as the source run itself was
  const withHistory = withPreviousRun(report, outDir, previous.run.startedAt);

  return persistRun({
    report: withHistory,
    result,
    outDir,
    runDir,
    artifacts: new FsArtifactStore(runDir),
    formats: options.formats,
  });
}
