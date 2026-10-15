import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { openStore } from "./store";

function makeIssue(id: string, runId: string): Issue {
  return {
    id,
    runId,
    ruleId: "res.img.failed",
    category: "links-resources",
    pageUrl: "http://localhost:4000/products/backpack",
    viewport: "all",
    title: "Image failed to load",
    severity: "high",
    confidence: 1,
    verdict: "fail",
    status: "new",
    evidence: [
      {
        type: "network",
        requestUrl: "http://localhost:4000/x.jpg",
        method: "GET",
        status: 404,
        resourceType: "image",
      },
    ],
    explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
    fix: { verifyCriterion: "2xx" },
    fingerprint: "0123456789abcdef",
    groupId: "g_1",
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    statusHistory: [{ from: null, to: "new", runId, at: "2026-10-15T10:00:00.000Z" }],
  };
}

function makeReport(runId: string, issueCount = 3): Report {
  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: runId,
      status: "completed",
      settings: {
        startUrl: "http://localhost:4000/",
        maxPages: 50,
        maxDepth: 3,
        viewports: ["desktop"],
        categories: ["seo"],
        respectRobots: true,
      },
      scannerVersion: "0.0.0",
      startedAt: "2026-10-15T10:00:00.000Z",
      partial: true,
      stopReason: "max-pages",
    },
    pages: [
      {
        url: "http://localhost:4000/",
        finalUrl: "http://localhost:4000/",
        status: 200,
        depth: 0,
        viewport: "desktop",
        title: "Home",
        screenshotKey: "screenshots/a-desktop.webp",
        screenshotTruncated: false,
      },
    ],
    issues: Array.from({ length: issueCount }, (_, i) => makeIssue(`${runId}-i${i}`, runId)),
    groups: [
      {
        id: "g_1",
        runId,
        ruleId: "res.img.failed",
        signature: "sig",
        hypothesis: true,
        confidence: 0.6,
        issueIds: [`${runId}-i0`, `${runId}-i1`],
        affectedPages: 2,
      },
    ],
  };
}

describe("openStore", () => {
  it("round-trips a report", () => {
    const store = openStore(":memory:");
    const report = makeReport("r1");
    store.saveReport(report);
    expect(store.getReport("r1")).toEqual(report);
    store.close();
  });

  it("replaces a run saved twice and lists runs newest first", () => {
    const store = openStore(":memory:");
    store.saveReport(makeReport("r1", 3));
    store.saveReport(makeReport("r1", 1));
    const later = makeReport("r2");
    later.run.startedAt = "2026-10-16T10:00:00.000Z";
    store.saveReport(later);

    expect(store.getReport("r1")?.issues).toHaveLength(1);
    expect(store.listRuns().map((r) => r.id)).toEqual(["r2", "r1"]);
    store.close();
  });

  it("inserts reports larger than the SQLite parameter chunk size", () => {
    const store = openStore(":memory:");
    store.saveReport(makeReport("big", 120));
    expect(store.getReport("big")?.issues).toHaveLength(120);
    store.close();
  });

  it("returns undefined for an unknown run", () => {
    const store = openStore(":memory:");
    expect(store.getReport("nope")).toBeUndefined();
    store.close();
  });
});
