import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { openStore, siteOf } from "./store";

const issue = (id: string, runId: string, over: Partial<Issue> = {}): Issue => ({
  id,
  runId,
  ruleId: "seo.h1.missing",
  category: "seo",
  pageUrl: "http://site.test/a",
  viewport: "all",
  title: "Page has no <h1>",
  severity: "medium",
  confidence: 1,
  verdict: "fail",
  status: "new",
  evidence: [{ type: "console", level: "error", text: "x" }],
  explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
  fingerprint: `fp-${id}`,
  firstSeenRunId: runId,
  lastSeenRunId: runId,
  statusHistory: [{ from: null, to: "new", runId, at: "2026-10-20T10:00:00.000Z" }],
  ...over,
});

const report = (
  id: string,
  startedAt: string,
  issues: Issue[],
  run: Partial<Report["run"]> = {},
  startUrl = "http://site.test/",
): Report => ({
  schemaVersion: SCHEMA_VERSION,
  run: {
    id,
    status: "completed",
    settings: {
      startUrl,
      maxPages: 10,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["seo"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt,
    partial: false,
    ...run,
  },
  pages: [],
  issues,
  groups: [],
});

describe("run history in the store", () => {
  it("saves previous run, link-check coverage and a summary, and reads them back", () => {
    const store = openStore(":memory:");
    store.saveReport(
      report("r2", "2026-10-21T10:00:00.000Z", [issue("a", "r2")], {
        previousRunId: "r1",
        externalLinksCapped: true,
      }),
    );
    const back = store.getReport("r2")!;
    expect(back.run).toMatchObject({ previousRunId: "r1", externalLinksCapped: true });
    expect(back.run.summary).toMatchObject({ total: 1, failing: 1, new: 1 });
    store.close();
  });

  it("lists runs with their site, comparison base and numbers", () => {
    const store = openStore(":memory:");
    store.saveReport(report("r1", "2026-10-20T10:00:00.000Z", [issue("a", "r1")]));
    store.saveReport(
      report("r2", "2026-10-21T10:00:00.000Z", [issue("b", "r2")], { previousRunId: "r1" }),
    );
    const [newest, oldest] = store.listRuns();
    expect(newest).toMatchObject({
      id: "r2",
      site: "http://site.test",
      previousRunId: "r1",
      failCount: 1,
    });
    expect(oldest!.previousRunId).toBeUndefined();
    store.close();
  });

  it("finds the newest earlier finished run of the same site only", () => {
    const store = openStore(":memory:");
    store.saveReport(report("old", "2026-10-19T10:00:00.000Z", []));
    store.saveReport(
      report("mid", "2026-10-20T10:00:00.000Z", [], {
        status: "completed_with_warnings",
        partial: true,
      }),
    );
    store.saveReport(report("failed", "2026-10-20T12:00:00.000Z", [], { status: "failed" }));
    store.saveReport(report("other", "2026-10-20T13:00:00.000Z", [], {}, "http://other.test/"));
    store.saveReport(report("later", "2026-10-22T10:00:00.000Z", []));

    expect(store.findPreviousRun("http://site.test/shop", "2026-10-21T10:00:00.000Z")?.id).toBe(
      "mid",
    );
    expect(store.findPreviousRun("http://site.test/", "2026-10-19T10:00:00.000Z")).toBeUndefined();
    expect(store.findPreviousRun("http://other.test/x", "2026-10-30T00:00:00.000Z")?.id).toBe(
      "other",
    );
    expect(
      store.findPreviousRun("http://nowhere.test/", "2026-10-30T00:00:00.000Z"),
    ).toBeUndefined();
    store.close();
  });

  it("never uses a re-analyzed run as the comparison base: it is not a separate scan", () => {
    const store = openStore(":memory:");
    store.saveReport(report("scan-1", "2026-10-20T10:00:00.000Z", []));
    store.saveReport(report("again", "2026-10-20T10:00:00.000Z", [], { reanalyzedFrom: "scan-1" }));
    store.saveReport(report("scan-2", "2026-10-21T10:00:00.000Z", []));
    expect(store.findPreviousRun("http://site.test/", "2026-10-22T10:00:00.000Z")?.id).toBe(
      "scan-2",
    );
    expect(store.findPreviousRun("http://site.test/", "2026-10-21T10:00:00.000Z")?.id).toBe(
      "scan-1",
    );
    expect(store.listRuns().find((r) => r.id === "again")?.reanalyzedFrom).toBe("scan-1");
    store.close();
  });

  it("recomputes the numbers of a run when a fix is verified", () => {
    const store = openStore(":memory:");
    const a = issue("a", "r1");
    store.saveReport(report("r1", "2026-10-20T10:00:00.000Z", [a, issue("b", "r1")]));
    expect(store.listRuns()[0]!.summary).toMatchObject({ failing: 2, fixed: 0 });

    store.updateIssues([
      {
        ...a,
        status: "fixed",
        statusHistory: [
          ...a.statusHistory,
          { from: "new", to: "fixed", runId: "r1", at: "2026-10-20T11:00:00.000Z" },
        ],
      },
    ]);
    expect(store.listRuns()[0]!.summary).toMatchObject({ failing: 1, fixed: 1, fixedSinceLast: 1 });
    expect(store.getReport("r1")!.run.summary).toMatchObject({ failing: 1, fixed: 1 });
    store.close();
  });

  it("keeps issues that were carried over (older lastSeenRunId) out of the failing count", () => {
    const store = openStore(":memory:");
    store.saveReport(
      report("r2", "2026-10-21T10:00:00.000Z", [
        issue("a", "r2", { status: "open", lastSeenRunId: "r2" }),
        issue("b", "r2", { status: "open", lastSeenRunId: "r1" }),
      ]),
    );
    expect(store.listRuns()[0]!.summary).toMatchObject({ failing: 1, notRechecked: 1 });
    store.close();
  });
});

describe("siteOf", () => {
  it("is the origin, so every page of a site shares one history", () => {
    expect(siteOf("https://www.shop.test/en/cart?x=1")).toBe("https://www.shop.test");
    expect(siteOf("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(siteOf("not a url")).toBe("not a url");
  });
});
