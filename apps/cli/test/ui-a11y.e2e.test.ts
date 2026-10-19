import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "@webdoctor/api";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { runScan } from "@webdoctor/runner";
type FastifyInstance = Awaited<ReturnType<typeof createApiServer>>;

/** Web Doctor audits its own UI with axe: no critical or serious findings on the key screens. */

const root = fileURLToPath(new URL("../../..", import.meta.url));
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
const TOKEN = "a11y";
const out = mkdtempSync(join(tmpdir(), "wd-a11y-"));

let site: DemoSite;
let app: FastifyInstance;
let browser: Browser;
let base = "";
let runId = "";
let issueId = "";

beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@webdoctor/web", "build"], {
    cwd: root,
    shell: process.platform === "win32",
  });
  site = await startDemoSite({ mode: "broken" });
  const result = await runScan({
    url: site.url,
    outDir: out,
    maxPages: 4,
    viewports: ["desktop", "mobile"],
    formats: ["json"],
  });
  runId = result.report.run.id;
  issueId = result.report.issues.find((i) => i.verdict === "fail")!.id;
  app = await createApiServer({
    dataDir: out,
    token: TOKEN,
    webDir: join(root, "apps/web/dist"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await site?.close();
  rmSync(out, { recursive: true, force: true });
});

const screens: [string, () => string][] = [
  ["runs list", () => "#/"],
  ["new scan", () => "#/new"],
  ["run workspace", () => `#/runs/${encodeURIComponent(runId)}`],
  ["site map", () => `#/runs/${encodeURIComponent(runId)}/map`],
  [
    "issue details",
    () => `#/runs/${encodeURIComponent(runId)}?issue=${encodeURIComponent(issueId)}`,
  ],
];

describe("the inspector passes its own axe audit", () => {
  for (const [scheme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 375],
  ] as const) {
    for (const [name, hash] of screens) {
      it(`${name} (${scheme}, ${width}px)`, async () => {
        const context = await browser.newContext({
          colorScheme: scheme,
          bypassCSP: true,
          viewport: { width, height: width > 600 ? 800 : 812 },
        });
        const page = await context.newPage();
        try {
          await page.goto(`${base}/?token=${TOKEN}${hash()}`);
          await page.waitForSelector("main, .app", { timeout: 15_000 });
          await page.waitForLoadState("networkidle");
          await page.addScriptTag({ content: axeSource });
          const violations = await page.evaluate(async () => {
            const axe = (
              window as unknown as {
                axe: {
                  run: (
                    c: Document,
                    o: object,
                  ) => Promise<{
                    violations: {
                      id: string;
                      impact: string;
                      help: string;
                      nodes: { target: string[] }[];
                    }[];
                  }>;
                };
              }
            ).axe;
            const res = await axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
            });
            return res.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
            }));
          });
          const serious = violations.filter(
            (v) => v.impact === "critical" || v.impact === "serious",
          );
          expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }
});
