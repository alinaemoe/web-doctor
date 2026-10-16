#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { createApiServer } from "@webdoctor/api";
import { openStore } from "@webdoctor/storage";
import { verifyAndSave } from "@webdoctor/verify";
import type { Category, ScanViewport, Severity } from "@webdoctor/core";
import { ALL_CATEGORIES, SEVERITY_RANK, runScan } from "./runScan";
import type { ReportFormat } from "./runScan";

const EXIT = { ok: 0, issues: 1, usage: 2, partial: 3 } as const;

const CATEGORY_ALIASES: Record<string, Category> = {
  links: "links-resources",
  "links-resources": "links-resources",
  a11y: "accessibility",
  accessibility: "accessibility",
  seo: "seo",
  runtime: "runtime",
};

function list(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(EXIT.usage);
}

const cli = cac("webdoctor");

cli
  .command("scan <url>", "Crawl a site and report problems with evidence")
  .option("--max-pages <n>", "Maximum pages to scan", { default: 50 })
  .option("--depth <n>", "Maximum crawl depth", { default: 3 })
  .option("--viewport <list>", "desktop,mobile", { default: "desktop,mobile" })
  .option("--categories <list>", "links,a11y,seo,runtime", { default: "links,a11y,seo,runtime" })
  .option("--format <list>", "json,csv,html", { default: "json,csv,html" })
  .option("--out <dir>", "Output directory", { default: ".webdoctor" })
  .option("--timeout <seconds>", "Total time budget", { default: 600 })
  .option("--ignore-robots", "Do not obey robots.txt (only for sites you own)")
  .option("--ci", "Machine-friendly output")
  .option("--fail-on <severity>", "Exit with 1 if a failing issue has at least this severity")
  .action(async (url: string, flags: Record<string, unknown>) => {
    const viewports = list(String(flags.viewport)) as ScanViewport[];
    if (!viewports.length || viewports.some((v) => v !== "desktop" && v !== "mobile")) {
      fail("--viewport must be a list of desktop,mobile");
    }
    const categories = list(String(flags.categories)).map((c) => {
      const mapped = CATEGORY_ALIASES[c];
      if (!mapped)
        fail(`unknown category "${c}" (use ${Object.keys(CATEGORY_ALIASES).join(", ")})`);
      return mapped;
    });
    const formats = list(String(flags.format)) as ReportFormat[];
    if (formats.some((f) => !["json", "csv", "html"].includes(f)))
      fail("--format: json, csv, html");
    const failOn = flags.failOn as Severity | undefined;
    if (failOn && !(failOn in SEVERITY_RANK)) fail("--fail-on: critical, high, medium, low, info");
    const num = (v: unknown, name: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number`);
      return n;
    };

    const controller = new AbortController();
    process.once("SIGINT", () => {
      console.error("\ncanceling… saving partial results");
      controller.abort();
    });

    const quiet = Boolean(flags.ci);
    let result;
    try {
      result = await runScan({
        url,
        outDir: String(flags.out),
        maxPages: num(flags.maxPages, "--max-pages"),
        maxDepth: num(flags.depth, "--depth"),
        viewports,
        categories: categories.length ? [...new Set(categories)] : ALL_CATEGORIES,
        formats,
        respectRobots: !flags.ignoreRobots,
        timeoutMs: num(flags.timeout, "--timeout") * 1000,
        signal: controller.signal,
        onProgress: (e) => {
          if (quiet) return;
          if (e.type === "page") console.error(`  [${e.done}] ${e.viewport.padEnd(7)} ${e.url}`);
          else if (e.type === "links") console.error(`  checking ${e.total} link targets…`);
        },
      });
    } catch (error) {
      fail((error as Error).message);
    }

    const { report, runDir } = result;
    const failing = report.issues.filter((i) => i.verdict === "fail");
    const unverified = report.issues.length - failing.length;
    const counts = (["critical", "high", "medium", "low", "info"] as const)
      .map((s) => `${failing.filter((i) => i.severity === s).length} ${s}`)
      .join(", ");
    console.log(
      `\nScanned ${new Set(report.pages.map((p) => p.url)).size} pages${report.run.partial ? ` (partial: ${report.run.stopReason})` : ""}`,
    );
    console.log(
      `Issues: ${failing.length} (${counts}); ${unverified} couldn't be verified; ${report.groups.length} root-cause groups`,
    );
    console.log(`Reports: ${runDir}`);

    if (failOn && failing.some((i) => SEVERITY_RANK[i.severity] >= SEVERITY_RANK[failOn])) {
      process.exit(EXIT.issues);
    }
    process.exit(report.run.partial ? EXIT.partial : EXIT.ok);
  });

cli
  .command("ui", "Serve the local inspector for scan results (listens on 127.0.0.1 only)")
  .option("--dir <dir>", "Directory with scan results (the --out of scan)", {
    default: ".webdoctor",
  })
  .option("--port <n>", "Port", { default: 7777 })
  .option("--token <token>", "Access token (random by default)")
  .action(async (flags: Record<string, unknown>) => {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be 0-65535");
    const token =
      typeof flags.token === "string" && flags.token
        ? flags.token
        : randomBytes(16).toString("hex");
    const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

    const app = await createApiServer({ dataDir: String(flags.dir), token, webDir });
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (error) {
      fail(`cannot listen on 127.0.0.1:${port}: ${(error as Error).message}`);
    }
    const address = app.server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    if (!existsSync(webDir)) {
      console.error("note: the UI is not built yet. Run: pnpm --filter @webdoctor/web build");
    }
    console.log(`Web Doctor inspector: http://127.0.0.1:${actual}/?token=${token}`);
    console.log("Press Ctrl+C to stop.");
    process.once("SIGINT", () => void app.close().then(() => process.exit(0)));
  });

cli
  .command("verify <issueId>", "Re-check one issue of a saved run and say whether it is fixed")
  .option("--dir <dir>", "Directory with scan results", { default: ".webdoctor" })
  .option("--run <runId>", "Run containing the issue (default: the newest run that has it)")
  .action(async (issueId: string, flags: Record<string, unknown>) => {
    const dir = resolve(String(flags.dir));
    const store = openStore(join(dir, "webdoctor.db"));
    try {
      const runs = store.listRuns();
      const runId =
        typeof flags.run === "string"
          ? flags.run
          : runs.find((r) => store.getReport(r.id)?.issues.some((i) => i.id === issueId))?.id;
      if (!runId) fail(`issue ${issueId} not found in any run under ${dir}`);

      const { results, issues } = await verifyAndSave(store, runId, [issueId]).catch((error) =>
        fail((error as Error).message),
      );
      const [v] = results;
      const [issue] = issues;
      const label = {
        "verified-fixed": "VERIFIED FIXED",
        "still-failing": "STILL FAILING",
        unverified: "COULDN'T VERIFY",
      }[v!.outcome];
      console.log(`${label}: ${issue!.title}`);
      console.log(`  ${issue!.explanation.where}`);
      console.log(`  ${v!.detail}`);
      if (v!.confidence > 0 && v!.confidence < 1) {
        console.log(`  confidence ${Math.round(v!.confidence * 100)}%`);
      }
      process.exit(
        v!.outcome === "verified-fixed"
          ? EXIT.ok
          : v!.outcome === "still-failing"
            ? EXIT.issues
            : EXIT.partial,
      );
    } finally {
      store.close();
    }
  });

cli.help();
cli.version("0.0.0");

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
  if (!cli.matchedCommand && !cli.options.help && !cli.options.version) cli.outputHelp();
} catch (error) {
  fail((error as Error).message);
}
