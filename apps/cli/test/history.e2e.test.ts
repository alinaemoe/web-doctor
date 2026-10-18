import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNotRechecked } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { runScan } from "@webdoctor/runner";

/**
 * Regression Radar end to end: Broken Shop is scanned broken, then fixed, then broken again, then
 * partly rechecked while a page is down. Desktop only, to keep it fast.
 */
const outDir = mkdtempSync(join(tmpdir(), "wd-history-"));
let site: DemoSite;
const runs: Record<string, Report> = {};

const scan = async (name: string, extra: { maxPages?: number } = {}) => {
  const { report } = await runScan({ url: site.url, outDir, viewports: ["desktop"], ...extra });
  runs[name] = report;
  return report;
};
const failing = (r: Report) => r.issues.filter((i) => i.verdict === "fail");
const byStatus = (r: Report, status: Issue["status"]) =>
  r.issues.filter((i) => i.status === status);

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
  await scan("A"); // broken, first run

  site.setMode("fixed");
  await scan("B"); // everything fixed

  site.setMode("broken");
  await scan("C"); // the same defects are back

  site.setMode("fixed");
  site.setPathDown("/cart", true);
  await scan("D"); // fixed again, but /cart is down
}, 600_000);

afterAll(async () => {
  await site.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("first run", () => {
  it("has no previous run and everything is new", () => {
    const a = runs.A!;
    expect(a.run.previousRunId).toBeUndefined();
    expect(a.run.summary).toMatchObject({ failing: failing(a).length, new: failing(a).length });
    expect(a.run.summary!.fixedSinceLast).toBe(0);
  });
});

describe("after the site was fixed", () => {
  it("is compared with the first run and reports every problem as fixed", () => {
    const [a, b] = [runs.A!, runs.B!];
    expect(b.run.previousRunId).toBe(a.run.id);
    expect(b.run.summary).toMatchObject({ failing: 0, new: 0, reopened: 0, notRechecked: 0 });
    expect(b.run.summary!.fixedSinceLast).toBe(failing(a).length);
    // each fixed problem keeps its identity and history from the first run
    const fixed = byStatus(b, "fixed");
    expect(fixed.map((i) => i.fingerprint).sort()).toEqual(
      failing(a)
        .map((i) => i.fingerprint)
        .sort(),
    );
    expect(fixed.every((i) => i.firstSeenRunId === a.run.id)).toBe(true);
    expect(fixed[0]!.statusHistory.map((h) => h.to)).toEqual(["new", "fixed"]);
    expect(fixed.every((i) => i.runId === b.run.id && i.id !== a.issues[0]!.id)).toBe(true);
  });

  it("does not turn the unverifiable external link into a fix", () => {
    const ext = runs.B!.issues.filter((i) => i.ruleId === "link.external.broken");
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ verdict: "unverified", status: "unverified" });
  });
});

describe("after the problems came back", () => {
  it("marks them reopened, not new, and keeps the original first-seen run", () => {
    const [a, c] = [runs.A!, runs.C!];
    expect(c.run.previousRunId).toBe(runs.B!.run.id);
    expect(c.run.summary).toMatchObject({ new: 0, reopened: failing(a).length, fixedSinceLast: 0 });
    const reopened = byStatus(c, "reopened");
    expect(reopened.map((i) => i.fingerprint).sort()).toEqual(
      failing(a)
        .map((i) => i.fingerprint)
        .sort(),
    );
    expect(
      reopened.every((i) => i.firstSeenRunId === a.run.id && i.lastSeenRunId === c.run.id),
    ).toBe(true);
    expect(reopened[0]!.statusHistory.map((h) => h.to)).toEqual(["new", "fixed", "reopened"]);
  });
});

describe("a page that is down", () => {
  it("never makes its problems look fixed", () => {
    const d = runs.D!;
    const cartIssues = d.issues.filter((i) => new URL(i.pageUrl).pathname === "/cart");
    expect(cartIssues.length).toBeGreaterThan(0);
    for (const issue of cartIssues) {
      expect(issue.status, issue.ruleId).not.toBe("fixed");
      expect(isNotRechecked(issue, d.run.id)).toBe(true);
    }
    expect(d.run.summary!.notRechecked).toBe(cartIssues.length);
  });

  it("still confirms the fixes on every page that was scanned", () => {
    const d = runs.D!;
    const fixedNow = byStatus(d, "fixed").filter((i) => i.statusHistory.at(-1)!.runId === d.run.id);
    expect(fixedNow.length).toBeGreaterThan(0);
    const scanned = new Set(d.pages.map((p) => new URL(p.url).pathname));
    for (const issue of fixedNow) {
      // a page-level problem is only fixed if the page was really looked at again
      if (!issue.ruleId.startsWith("seo.sitemap.")) {
        expect(scanned.has(new URL(issue.pageUrl).pathname), issue.ruleId).toBe(true);
      }
    }
    expect(scanned.has("/cart")).toBe(false);
  });
});

describe("history command", () => {
  it("lists the runs of the site with what changed between them", async () => {
    const run = promisify(execFile);
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "src/main.ts", "history", "--dir", outDir],
      {
        cwd,
      },
    );
    expect(stdout).toContain(site.url);
    for (const name of ["A", "B", "C", "D"]) expect(stdout).toContain(runs[name]!.run.id);
    expect(stdout.split("\n").filter((l) => l.includes("run-")).length).toBe(4);
  }, 60_000);
});
