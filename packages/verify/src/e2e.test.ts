import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { analyze } from "@webdoctor/rules";
import { FsArtifactStore, SCANNER_VERSION, scan } from "@webdoctor/scanner";
import { openStore } from "@webdoctor/storage";
import type { Store } from "@webdoctor/storage";
import { verifyAndSave, verifyGroupAndSave } from "./run";

/** Broken Shop end to end: scan it broken, then verify while broken, fixed and unreachable. */
let site: DemoSite;
let store: Store;
let report: Report;
const dir = mkdtempSync(join(tmpdir(), "wd-verify-"));
const RUN = "run-verify";

// How pages link to each other (nav.*) can only be re-checked by a new scan, see below
const isPageProblem = (i: Issue) => !i.ruleId.startsWith("nav.");
const failing = () => report.issues.filter((i) => i.verdict === "fail" && isPageProblem(i));
const oneOfEachRule = (): Issue[] => {
  const seen = new Map<string, Issue>();
  for (const i of failing()) if (!seen.has(i.ruleId)) seen.set(i.ruleId, i);
  return [...seen.values()];
};

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
  const result = await scan({ startUrl: site.url, artifacts: new FsArtifactStore(dir) });
  const { issues, groups } = analyze(result, { runId: RUN });
  report = {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: RUN,
      status: "completed",
      settings: {
        startUrl: result.startUrl,
        maxPages: 50,
        maxDepth: 3,
        viewports: ["desktop", "mobile"],
        categories: ["links-resources", "accessibility", "seo", "runtime"],
        respectRobots: true,
      },
      scannerVersion: SCANNER_VERSION,
      startedAt: result.startedAt,
      partial: result.partial,
    },
    pages: [],
    issues,
    groups,
  };
  store = openStore(":memory:");
  store.saveReport(report);
}, 240_000);

afterAll(async () => {
  store.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Verify Fix on Broken Shop", () => {
  it("keeps every issue failing while the site is still broken", async () => {
    const sample = oneOfEachRule();
    expect(sample.length).toBeGreaterThanOrEqual(15);

    const { results, issues } = await verifyAndSave(
      store,
      RUN,
      sample.map((i) => i.id),
    );
    expect(results.filter((r) => r.outcome !== "still-failing").map((r) => r.detail)).toEqual([]);
    expect(issues.every((i) => i.status === "new")).toBe(true);
    expect(store.getReport(RUN)!.issues.filter((i) => i.status === "fixed")).toEqual([]);
  }, 180_000);

  it("re-checks a sample of a root-cause group and says how many pages it covered", async () => {
    const group = report.groups.find((g) => g.ruleId === "seo.h1.missing")!;
    const res = await verifyGroupAndSave(store, RUN, group.id, 5);
    expect(res.checkedPages).toBe(5);
    expect(res.totalPages).toBe(18);
    expect(res.results.every((r) => r.outcome === "still-failing")).toBe(true);
  }, 120_000);

  it("confirms every fix once the site is fixed, and persists it", async () => {
    site.setMode("fixed");
    const all = failing();
    const { results, issues } = await verifyAndSave(
      store,
      RUN,
      all.map((i) => i.id),
    );

    const notFixed = results.filter((r) => r.outcome !== "verified-fixed");
    expect(notFixed.map((r) => `${r.issueId}: ${r.detail}`)).toEqual([]);
    expect(issues.every((i) => i.status === "fixed")).toBe(true);

    const saved = store.getReport(RUN)!;
    expect(
      saved.issues
        .filter((i) => i.verdict === "fail" && isPageProblem(i))
        .every((i) => i.status === "fixed"),
    ).toBe(true);
    const history = saved.issues[0]!.statusHistory;
    expect(history.at(-1)).toMatchObject({ to: "fixed" });
    expect(history.at(-1)!.reason).toContain("Re-verified");
    expect(store.listVerifications(RUN).length).toBeGreaterThan(all.length);
  }, 240_000);

  it("never calls a link-structure problem fixed: it needs a new scan", async () => {
    const nav = report.issues.find((i) => i.ruleId.startsWith("nav."));
    expect(nav, "Broken Shop has an orphan page").toBeDefined();
    const { results } = await verifyAndSave(store, RUN, [nav!.id]);
    expect(results[0]).toMatchObject({ outcome: "unverified", reason: "needs_manual_review" });
  }, 60_000);

  it("leaves the external 429 link unverified: it is not something the site can fix", async () => {
    const ext = report.issues.find((i) => i.ruleId === "link.external.broken")!;
    const { results, issues } = await verifyAndSave(store, RUN, [ext.id]);
    expect(results[0]).toMatchObject({ outcome: "unverified", reason: "rate_limited" });
    expect(issues[0]!.status).toBe("unverified");
  }, 60_000);

  it("never reports 'fixed' when the site cannot be reached", async () => {
    const issue = failing().find((i) => i.ruleId === "runtime.console.error")!;
    await site.close();

    const { results, issues } = await verifyAndSave(store, RUN, [issue.id], {
      pageTimeoutMs: 5000,
    });
    expect(results[0]).toMatchObject({
      outcome: "unverified",
      reason: "page_unreachable",
      confidence: 0,
    });
    // it was fixed before; an unreachable site must not change that either way
    expect(issues[0]!.status).toBe("fixed");
  }, 60_000);
});
