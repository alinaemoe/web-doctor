#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import { DEEP_CLICKS, isNotRechecked } from "@webdoctor/core";
import { createApiServer } from "@webdoctor/api";
import { openStore } from "@webdoctor/storage";
import { verifyAndSave } from "@webdoctor/verify";
import type { Category, ScanViewport, Severity } from "@webdoctor/core";
import {
  ALL_CATEGORIES,
  SEVERITY_RANK,
  reanalyzeRun,
  runScan,
  toAnnotations,
  toCiSummary,
  toFixPrompt,
} from "@webdoctor/runner";
import type { ReportFormat } from "@webdoctor/runner";

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
  .option("--format <list>", "json,csv,html,md (md = fix prompt for an AI agent)", {
    default: "json,csv,html,md",
  })
  .option("--out <dir>", "Output directory", { default: ".webdoctor" })
  .option("--timeout <seconds>", "Total time budget", { default: 600 })
  .option("--max-external <n>", "Max external addresses to check links of", { default: 100 })
  .option("--ignore-robots", "Do not obey robots.txt (only for sites you own)")
  .option("--ci", "Machine-friendly output")
  .option("--new-only", "With --fail-on: only new or reopened problems count (regressions)")
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
    if (formats.some((f) => !["json", "csv", "html", "md"].includes(f))) {
      fail("--format: json, csv, html, md");
    }
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
        maxExternalLinks: num(flags.maxExternal, "--max-external"),
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
    // what this scan actually saw: not fixed, not carried over from an earlier scan
    const seenNow = report.issues.filter(
      (i) => i.status !== "fixed" && i.status !== "ignored" && !isNotRechecked(i, report.run.id),
    );
    const failing = seenNow.filter((i) => i.verdict === "fail");
    const unverified = seenNow.length - failing.length;
    const counts = (["critical", "high", "medium", "low", "info"] as const)
      .map((s) => `${failing.filter((i) => i.severity === s).length} ${s}`)
      .join(", ");
    console.log(
      `\nScanned ${new Set(report.pages.map((p) => p.url)).size} pages${report.run.partial ? ` (partial: ${report.run.stopReason})` : ""}`,
    );
    console.log(
      `Issues: ${failing.length} (${counts}); ${unverified} couldn't be verified; ${report.groups.length} root-cause groups`,
    );
    if (report.graph) {
      const { nodes, home, complete } = report.graph;
      const scannedNodes = nodes.filter((n) => n.scanned);
      const hidden = scannedNodes.filter((n) => n.depth === undefined && n !== nodes[home]).length;
      const deep = scannedNodes.filter((n) => (n.depth ?? 0) >= DEEP_CLICKS).length;
      console.log(
        `Link structure: ${hidden} not reachable by clicks, ${deep} deeper than ${DEEP_CLICKS - 1} clicks${complete ? "" : " (tentative: not every page was scanned)"}`,
      );
    }
    const delta = report.run.summary;
    if (report.run.previousRunId && delta) {
      console.log(
        `Since the previous scan: +${delta.new} new, -${delta.fixedSinceLast} fixed, ${delta.reopened} came back, ${delta.notRechecked} not rechecked`,
      );
    }
    if (report.run.sitemapUrls && report.run.sitemapUrls > report.pages.length / viewports.length) {
      console.log(
        `Coverage: the sitemap lists ${report.run.sitemapUrls} pages; a sample was scanned (raise --max-pages to see more).`,
      );
    }
    console.log(`Reports: ${runDir}`);
    if (formats.includes("md"))
      console.log(`Fix prompt for an AI agent: ${join(runDir, "fix-prompt.md")}`);

    const counted = flags.newOnly
      ? failing.filter((i) => i.status === "new" || i.status === "reopened")
      : failing;
    const breaking = failOn
      ? counted.filter((i) => SEVERITY_RANK[i.severity] >= SEVERITY_RANK[failOn])
      : [];
    if (process.env.GITHUB_ACTIONS === "true" && flags.ci) {
      for (const line of toAnnotations(breaking)) console.log(line);
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        appendFileSync(
          summaryFile,
          toCiSummary(report, failing, { failOn, failed: breaking.length > 0 }),
        );
      }
    }
    if (breaking.length > 0) process.exit(EXIT.issues);
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
  .command("serve", "Run the public server: anyone can scan, nothing private can be reached")
  .option("--dir <dir>", "Directory for the database and run files", {
    default: ".webdoctor-public",
  })
  .option("--host <host>", "Address to listen on", { default: "127.0.0.1" })
  .option("--port <n>", "Port", { default: 8080 })
  .option("--secret <secret>", "Signs session tokens (default: $WEBDOCTOR_SECRET or random)")
  .option("--allow-host <names>", "Host names this server answers to, comma separated")
  .option("--trust-proxy", "Trust X-Forwarded-For (only behind your own reverse proxy)")
  .option("--demo", "Also run the Broken Shop demo site and allow scanning it")
  .option("--allow-origin <list>", "Private origins that may be scanned anyway (your own demo)")
  .option("--example <list>", "Addresses offered as one-click examples")
  .option("--max-pages <n>", "Pages per scan", { default: 20 })
  .option("--retention-hours <n>", "Delete runs after this many hours", { default: 24 })
  .action(async (flags: Record<string, unknown>) => {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be 0-65535");
    const maxPages = Number(flags.maxPages);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) {
      fail("--max-pages must be 1-200");
    }
    const retentionHours = Number(flags.retentionHours);
    if (!Number.isFinite(retentionHours) || retentionHours < 1) {
      fail("--retention-hours must be at least 1");
    }

    const envSecret = process.env.WEBDOCTOR_SECRET;
    const secret =
      typeof flags.secret === "string" && flags.secret ? flags.secret : envSecret || undefined;
    if (!secret) {
      console.error(
        "note: no secret given, sessions will end when the server restarts (set WEBDOCTOR_SECRET).",
      );
    }

    const allowOrigins = list(flags.allowOrigin as string | undefined);
    const examples = list(flags.example as string | undefined);
    let demo: { close(): Promise<void> } | undefined;
    if (flags.demo) {
      const { startDemoSite } = await import("@webdoctor/demo-site");
      const site = await startDemoSite({ mode: "broken" });
      demo = site;
      allowOrigins.push(new URL(site.url).origin, new URL(site.extUrl).origin);
      examples.unshift(site.url);
    }

    const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
    const app = await createApiServer({
      dataDir: String(flags.dir),
      webDir,
      public: {
        secret,
        allowOrigins,
        allowedHosts: list(flags.allowHost as string | undefined),
        trustProxy: Boolean(flags.trustProxy),
        examples,
        limits: { maxPages, retentionHours },
      },
    });
    try {
      await app.listen({ host: String(flags.host), port });
    } catch (error) {
      fail(`cannot listen on ${String(flags.host)}:${port}: ${(error as Error).message}`);
    }
    const address = app.server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    if (!existsSync(webDir)) {
      console.error("note: the UI is not built yet. Run: pnpm --filter @webdoctor/web build");
    }
    console.log(`Web Doctor public server: http://${String(flags.host)}:${actual}/`);
    if (demo) console.log(`Demo site is scannable at ${examples[0]}`);
    console.log("Press Ctrl+C to stop.");
    const stop = () => void Promise.all([app.close(), demo?.close()]).then(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
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

cli
  .command(
    "export [runId]",
    "Write the fix prompt (Markdown for an AI coding agent) of a saved run",
  )
  .option("--dir <dir>", "Directory with scan results", { default: ".webdoctor" })
  .option("--out <file>", "Write to this file instead of stdout")
  .option("--max-findings <n>", "Cap on findings listed in detail", { default: 40 })
  .option("--include-fixed", "Also mention problems already verified as fixed")
  .action((runId: string | undefined, flags: Record<string, unknown>) => {
    const store = openStore(join(resolve(String(flags.dir)), "webdoctor.db"));
    try {
      const id = runId ?? store.listRuns()[0]?.id;
      if (!id) fail("no runs found; run `webdoctor scan <url>` first");
      const report = store.getReport(id);
      if (!report) fail(`run ${id} not found`);
      const md = toFixPrompt(report, {
        maxFindings: Number(flags.maxFindings),
        includeFixed: Boolean(flags.includeFixed),
      });
      if (typeof flags.out === "string") {
        writeFileSync(resolve(flags.out), md);
        console.error(`wrote ${resolve(flags.out)}`);
      } else {
        process.stdout.write(md);
      }
    } finally {
      store.close();
    }
  });

cli
  .command(
    "reanalyze [runId]",
    "Run the current rules again over the saved snapshots of a run (no pages are loaded)",
  )
  .option("--dir <dir>", "Directory with scan results", { default: ".webdoctor" })
  .action(async (runId: string | undefined, flags: Record<string, unknown>) => {
    const dir = resolve(String(flags.dir));
    const store = openStore(join(dir, "webdoctor.db"));
    const id = runId ?? store.listRuns()[0]?.id;
    store.close();
    if (!id) fail("no runs found; run `webdoctor scan <url>` first");
    try {
      const { report, runDir } = await reanalyzeRun({ outDir: dir, runId: id });
      const failing = report.issues.filter((i) => i.verdict === "fail").length;
      console.log(
        `Re-analyzed ${id}: ${failing} problems, ${report.groups.length} root-cause groups -> new run ${report.run.id}`,
      );
      console.log(`Reports: ${runDir}`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

cli
  .command("history", "Show the runs of each site with what changed between them")
  .option("--dir <dir>", "Directory with scan results", { default: ".webdoctor" })
  .option("--site <origin>", "Only this site, e.g. https://example.com")
  .action((flags: Record<string, unknown>) => {
    const store = openStore(join(resolve(String(flags.dir)), "webdoctor.db"));
    try {
      const runs = store
        .listRuns()
        .filter((r) => !flags.site || r.site === String(flags.site).replace(/\/$/, ""));
      if (runs.length === 0) return console.log("No runs yet. Run `webdoctor scan <url>` first.");

      const bySite = new Map<string, typeof runs>();
      for (const r of runs) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);
      for (const [site, list] of bySite) {
        console.log(`\n${site}`);
        console.log("  started (UTC)         failing   new  fixed  back  not rechecked  run");
        for (const r of list) {
          const s = r.summary;
          const delta = r.previousRunId
            ? `${String(s.new).padStart(4)} ${String(s.fixedSinceLast).padStart(6)} ${String(s.reopened).padStart(5)}  ${String(s.notRechecked).padStart(13)}`
            : "   -      -     -              -";
          console.log(
            `  ${r.startedAt.slice(0, 19).replace("T", " ")}  ${String(s.failing).padStart(7)} ${delta}  ${r.id}${r.partial ? " (partial)" : ""}${r.reanalyzedFrom ? " (re-analyzed)" : ""}`,
          );
        }
      }
      console.log('\nnew / fixed / back are compared with the run before; "-" marks a first run.');
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
