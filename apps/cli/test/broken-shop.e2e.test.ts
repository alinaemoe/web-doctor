import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportSchema } from "@webdoctor/core";
import type { Report } from "@webdoctor/core";
import { expectedManifest, matchExpected, startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { openStore } from "@webdoctor/storage";
import { runScan } from "../src/runScan";
import type { RunScanResult } from "../src/runScan";

/** Full pipeline against Broken Shop: crawl, rules, storage, reports (needs Chromium). */
const outDir = mkdtempSync(join(tmpdir(), "wd-e2e-"));
let site: DemoSite;
let broken: RunScanResult;
let fixed: RunScanResult;

const crawledPaths = (r: Report) => [...new Set(r.pages.map((p) => new URL(p.url).pathname))];

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
  broken = await runScan({ url: site.url, outDir });
  site.setMode("fixed");
  fixed = await runScan({ url: site.url, outDir });
}, 280_000);

afterAll(async () => {
  await site.close();
  rmSync(outDir, { recursive: true, force: true });
});

describe("Broken Shop, broken mode", () => {
  it("finds every expected defect (DoD: >= 90% recall) with nothing unexpected", () => {
    const result = matchExpected(
      broken.report.issues,
      expectedManifest.modes.broken.issues,
      crawledPaths(broken.report),
    );
    expect(result.missing).toEqual([]);
    expect(result.recall).toBeGreaterThanOrEqual(0.9);
    expect(result.unexpected.map((i) => `${i.ruleId} ${i.pageUrl}`)).toEqual([]);
  });

  it("crawls all pages on both viewports and is not partial", () => {
    expect(crawledPaths(broken.report)).toHaveLength(27);
    expect(broken.report.pages).toHaveLength(54);
    expect(broken.report.run.partial).toBe(false);
  });

  it("collapses the shared template defects into root-cause groups", () => {
    const h1 = broken.report.groups.find((g) => g.ruleId === "seo.h1.missing");
    expect(h1).toMatchObject({ affectedPages: 18, hypothesis: true });
    expect(broken.report.groups.map((g) => g.ruleId).sort()).toEqual(
      [
        "link.internal.broken",
        "res.font.failed",
        "runtime.resource.heavy",
        "seo.h1.missing",
      ].sort(),
    );
  });

  it("reports the external 429 as unverified, never as broken", () => {
    const ext = broken.report.issues.filter((i) => i.ruleId === "link.external.broken");
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ verdict: "unverified", unverifiedReason: "rate_limited" });
  });

  it("gives every issue evidence and a four-part explanation", () => {
    for (const i of broken.report.issues) {
      expect(i.evidence.length, i.ruleId).toBeGreaterThan(0);
      for (const part of Object.values(i.explanation)) expect(part, i.ruleId).not.toBe("");
    }
  });

  it("writes json/csv/html reports and screenshots; the JSON validates", () => {
    for (const name of ["report.json", "issues.csv", "report.html", "scan.json"]) {
      expect(existsSync(join(broken.runDir, name)), name).toBe(true);
    }
    const json = JSON.parse(readFileSync(join(broken.runDir, "report.json"), "utf8"));
    expect(ReportSchema.safeParse(json).success).toBe(true);
    const shot = broken.report.pages.find((p) => p.screenshotKey)!;
    expect(existsSync(join(broken.runDir, shot.screenshotKey!))).toBe(true);
  });

  it("persists the run in SQLite", () => {
    const store = openStore(join(outDir, "webdoctor.db"));
    try {
      expect(store.listRuns().map((r) => r.id)).toContain(broken.report.run.id);
      expect(store.getReport(broken.report.run.id)?.issues).toHaveLength(
        broken.report.issues.length,
      );
    } finally {
      store.close();
    }
  });
});

describe("Broken Shop, fixed mode", () => {
  it("leaves only the unverifiable external link", () => {
    const result = matchExpected(
      fixed.report.issues,
      expectedManifest.modes.fixed.issues,
      crawledPaths(fixed.report),
    );
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(fixed.report.issues.filter((i) => i.verdict === "fail")).toEqual([]);
  });

  it("every issue left in fixed mode was already present (same fingerprint) when broken", () => {
    const brokenPrints = new Set(broken.report.issues.map((i) => i.fingerprint));
    for (const i of fixed.report.issues) expect(brokenPrints.has(i.fingerprint)).toBe(true);
  });
});
