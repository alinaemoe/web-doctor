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
    // the store adds the run summary (numbers shown in the history)
    expect(store.getReport("r1")).toEqual({
      ...report,
      run: { ...report.run, summary: expect.objectContaining({ total: 3, failing: 3 }) },
    });
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
    expect(store.listRuns()[0]).toMatchObject({ failCount: 3, unverifiedCount: 0 });
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

describe("owners and retention (public mode)", () => {
  const at = (runId: string, startedAt: string): Report => {
    const r = makeReport(runId, 1);
    r.run.startedAt = startedAt;
    return r;
  };

  it("keeps runs of different owners apart", () => {
    const store = openStore(":memory:");
    store.saveReport(at("a1", "2026-10-15T10:00:00.000Z"), "alice");
    store.saveReport(at("b1", "2026-10-15T11:00:00.000Z"), "bob");
    store.saveReport(at("local", "2026-10-15T12:00:00.000Z"));
    expect(store.listRuns({ owner: "alice" }).map((r) => r.id)).toEqual(["a1"]);
    expect(store.listRuns({ owner: "bob" }).map((r) => r.id)).toEqual(["b1"]);
    expect(store.listRuns({ owner: "nobody" })).toEqual([]);
    expect(store.listRuns().map((r) => r.id)).toEqual(["local", "b1", "a1"]);
    expect(store.getRunOwner("a1")).toBe("alice");
    expect(store.getRunOwner("local")).toBeNull();
    expect(store.getRunOwner("missing")).toBeUndefined();
    store.close();
  });

  it("builds history only from the same owner's runs", () => {
    const store = openStore(":memory:");
    store.saveReport(at("a1", "2026-10-15T10:00:00.000Z"), "alice");
    store.saveReport(at("b1", "2026-10-15T11:00:00.000Z"), "bob");
    const url = "http://localhost:4000/";
    expect(store.findPreviousRun(url, "2026-10-16T00:00:00.000Z", "alice")?.id).toBe("a1");
    expect(store.findPreviousRun(url, "2026-10-16T00:00:00.000Z", "carol")).toBeUndefined();
    store.close();
  });

  it("deletes runs older than the cutoff together with everything attached", () => {
    const store = openStore(":memory:");
    store.saveReport(at("old", "2026-10-01T10:00:00.000Z"), "alice");
    store.saveReport(at("new", "2026-10-15T10:00:00.000Z"), "alice");
    store.addVerifications("old", [
      {
        issueId: "old-i0",
        outcome: "unverified",
        reason: "page_unreachable",
        confidence: 0,
        detail: "x",
        checkedAt: "2026-10-02T00:00:00.000Z",
        pages: [],
      },
    ]);
    expect(store.deleteRunsOlderThan("2026-10-10T00:00:00.000Z")).toEqual(["old"]);
    expect(store.getReport("old")).toBeUndefined();
    expect(store.listVerifications("old")).toEqual([]);
    expect(store.getReport("new")?.issues).toHaveLength(1);
    expect(store.deleteRunsOlderThan("2026-10-10T00:00:00.000Z")).toEqual([]);
    store.close();
  });
});
