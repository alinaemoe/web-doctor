import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./schemas";
import { applyHistory, coverageOf, isNotRechecked, issueCovered, summarizeRun } from "./history";
import type { Category, Issue, Report, Status } from "./types";
import type { ScanViewport } from "./snapshot";

const T1 = "2026-10-20T10:00:00.000Z";
const T2 = "2026-10-21T10:00:00.000Z";

function issue(overrides: Partial<Issue> & { fingerprint: string }): Issue {
  return {
    id: overrides.id ?? `id-${overrides.fingerprint}`,
    runId: "r1",
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
    firstSeenRunId: "r1",
    lastSeenRunId: "r1",
    statusHistory: [{ from: null, to: "new", runId: "r1", at: T1 }],
    ...overrides,
  };
}

function report(
  runId: string,
  issues: Issue[],
  scanned: Record<string, ScanViewport[]> = { "http://site.test/a": ["desktop", "mobile"] },
  run: Partial<Report["run"]> = {},
  categories: Category[] = ["seo", "runtime", "accessibility", "links-resources"],
): Report {
  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: runId,
      status: "completed",
      settings: {
        startUrl: "http://site.test/",
        maxPages: 50,
        maxDepth: 3,
        viewports: ["desktop", "mobile"],
        categories,
        respectRobots: true,
      },
      scannerVersion: "0",
      startedAt: T2,
      partial: false,
      ...run,
    },
    pages: Object.entries(scanned).flatMap(([url, viewports]) =>
      viewports.map((viewport) => ({
        url,
        finalUrl: url,
        status: 200,
        depth: 0,
        viewport,
        title: null,
        screenshotTruncated: false,
      })),
    ),
    issues: issues.map((i) => ({ ...i, runId })),
    groups: [],
  };
}

let counter = 0;
const opts = { now: T2, newId: () => `carried-${++counter}` };
const statusOf = (issues: Issue[], fp: string) => issues.find((i) => i.fingerprint === fp)?.status;

describe("applyHistory", () => {
  it("leaves the first run alone: everything is new", () => {
    const current = report("r1", [issue({ fingerprint: "a" })]);
    expect(applyHistory(current, undefined, opts)).toEqual(current.issues);
  });

  it("marks a problem found in both runs as open and keeps its history and first-seen run", () => {
    const previous = report("r1", [issue({ fingerprint: "a" })]);
    const current = report("r2", [
      issue({ fingerprint: "a", firstSeenRunId: "r2", statusHistory: [] }),
    ]);
    const [a] = applyHistory(current, previous, opts);
    expect(a).toMatchObject({
      status: "open",
      firstSeenRunId: "r1",
      lastSeenRunId: "r2",
      runId: "r2",
    });
    expect(a!.statusHistory.map((h) => h.to)).toEqual(["new", "open"]);
  });

  it("keeps a problem that first appears in the newer run as new", () => {
    const previous = report("r1", []);
    const current = report("r2", [issue({ fingerprint: "b" })]);
    expect(statusOf(applyHistory(current, previous, opts), "b")).toBe("new");
  });

  it("marks a problem fixed only when the page was scanned again in every viewport it was seen in", () => {
    const previous = report("r1", [issue({ fingerprint: "a" })]);
    const current = report("r2", []); // scanned /a on both viewports, found nothing
    const out = applyHistory(current, previous, opts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "fixed", runId: "r2", lastSeenRunId: "r1" });
    expect(out[0]!.id).toBe("carried-1"); // a fresh row id, never the old one
    expect(out[0]!.statusHistory.at(-1)).toMatchObject({ from: "new", to: "fixed", runId: "r2" });
  });

  it("does NOT call a problem fixed when its page was not scanned this time (smaller sample)", () => {
    const previous = report("r1", [issue({ fingerprint: "a" })]);
    const current = report("r2", [], { "http://site.test/other": ["desktop", "mobile"] });
    const [a] = applyHistory(current, previous, opts);
    expect(a).toMatchObject({ status: "new", lastSeenRunId: "r1" });
    expect(isNotRechecked(a!, "r2")).toBe(true);
  });

  it("does NOT call it fixed when only one of the viewports was scanned", () => {
    const previous = report("r1", [issue({ fingerprint: "a", viewport: "all" })]);
    const current = report("r2", [], { "http://site.test/a": ["desktop"] });
    expect(applyHistory(current, previous, opts)[0]!.status).toBe("new");
    // a mobile-only problem is fixed by a mobile scan, and not by a desktop one
    const mobileOnly = report("r1", [issue({ fingerprint: "m", viewport: "mobile" })]);
    expect(
      applyHistory(report("r2", [], { "http://site.test/a": ["desktop"] }), mobileOnly, opts)[0]!
        .status,
    ).toBe("new");
    expect(
      applyHistory(report("r2", [], { "http://site.test/a": ["mobile"] }), mobileOnly, opts)[0]!
        .status,
    ).toBe("fixed");
  });

  it("does not trust a page that answered with an error", () => {
    const previous = report("r1", [issue({ fingerprint: "a" })]);
    const current = report("r2", []);
    current.pages[0]!.status = 503;
    current.pages[1]!.status = 503;
    expect(applyHistory(current, previous, opts)[0]!.status).toBe("new");
  });

  it("does not call it fixed when the category was not part of this run", () => {
    const previous = report("r1", [issue({ fingerprint: "a", category: "accessibility" })]);
    const current = report("r2", [], undefined, {}, ["seo"]);
    expect(applyHistory(current, previous, opts)[0]!.status).toBe("new");
  });

  it("does not call an external link fixed when the run only checked the first N external links", () => {
    const link = issue({
      fingerprint: "l",
      ruleId: "link.external.broken",
      category: "links-resources",
    });
    const previous = report("r1", [link]);
    expect(
      applyHistory(report("r2", [], undefined, { externalLinksCapped: true }), previous, opts)[0]!
        .status,
    ).toBe("new");
    expect(
      applyHistory(report("r2", [], undefined, { externalLinksCapped: false }), previous, opts)[0]!
        .status,
    ).toBe("fixed");
  });

  it("treats sitemap problems as covered whenever any page was scanned", () => {
    const sm = issue({
      fingerprint: "s",
      ruleId: "seo.sitemap.bad-entries",
      pageUrl: "http://site.test/sitemap.xml",
    });
    const previous = report("r1", [sm]);
    expect(applyHistory(report("r2", []), previous, opts)[0]!.status).toBe("fixed");
    expect(applyHistory(report("r2", [], {}), previous, opts)[0]!.status).toBe("new");
  });

  it("reopens a problem that was fixed and comes back, even after a run in between", () => {
    const r1 = report("r1", [issue({ fingerprint: "a" })]);
    const r2 = report("r2", []);
    r2.issues = applyHistory(r2, r1, opts); // a: fixed (carried)
    expect(r2.issues[0]!.status).toBe("fixed");

    const r3 = report("r3", []);
    r3.issues = applyHistory(r3, r2, opts); // still gone: the fixed record is carried forward
    expect(r3.issues).toHaveLength(1);
    expect(r3.issues[0]!.status).toBe("fixed");

    const r4 = report("r4", [issue({ fingerprint: "a", firstSeenRunId: "r4", statusHistory: [] })]);
    const out = applyHistory(r4, r3, opts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "reopened", firstSeenRunId: "r1" });
    expect(out[0]!.statusHistory.map((h) => h.to)).toEqual(["new", "fixed", "reopened"]);
  });

  it("keeps an inconclusive check as unverified instead of inventing a lifecycle state", () => {
    const u = (extra: Partial<Issue> = {}) =>
      issue({
        fingerprint: "u",
        verdict: "unverified",
        status: "unverified",
        unverifiedReason: "rate_limited",
        ...extra,
      });
    const out = applyHistory(report("r2", [u()]), report("r1", [u()]), opts);
    expect(out[0]!.status).toBe("unverified");
  });

  it("keeps an ignored problem ignored whether or not it is found", () => {
    const ignored = issue({ fingerprint: "i", status: "ignored" });
    const previous = report("r1", [ignored]);
    expect(
      applyHistory(report("r2", [issue({ fingerprint: "i" })]), previous, opts)[0]!.status,
    ).toBe("ignored");
    expect(applyHistory(report("r2", []), previous, opts)[0]!.status).toBe("ignored");
  });

  it("drops group links on carried issues (groups belong to one run)", () => {
    const previous = report("r1", [issue({ fingerprint: "a", groupId: "g_1" })]);
    expect(applyHistory(report("r2", []), previous, opts)[0]!.groupId).toBeUndefined();
  });

  it("handles a mix in one comparison", () => {
    const previous = report("r1", [
      issue({ fingerprint: "stay" }),
      issue({ fingerprint: "gone" }),
      issue({ fingerprint: "unseen", pageUrl: "http://site.test/unseen" }),
    ]);
    const current = report("r2", [issue({ fingerprint: "stay" }), issue({ fingerprint: "fresh" })]);
    const out = applyHistory(current, previous, opts);
    expect(Object.fromEntries(out.map((i) => [i.fingerprint, i.status]))).toEqual({
      stay: "open",
      fresh: "new",
      gone: "fixed",
      unseen: "new",
    });
  });
});

describe("coverageOf / issueCovered", () => {
  it("ignores error pages and remembers which viewports were scanned", () => {
    const r = report("r", [], {
      "http://site.test/a": ["desktop"],
      "http://site.test/b": ["desktop", "mobile"],
    });
    r.pages.find((p) => p.url.endsWith("/b") && p.viewport === "mobile")!.status = 500;
    const cov = coverageOf(r);
    expect([...cov.pages.get("/a")!]).toEqual(["desktop"]);
    expect([...cov.pages.get("/b")!]).toEqual(["desktop"]);
    expect(
      issueCovered(
        issue({ fingerprint: "x", pageUrl: "http://other-host.test/a", viewport: "desktop" }),
        cov,
      ),
    ).toBe(true);
  });
});

describe("summarizeRun", () => {
  const withStatus = (fingerprint: string, status: Status, extra: Partial<Issue> = {}) =>
    issue({ fingerprint, status, ...extra });

  it("counts what is open, what changed since the last run and what was not rechecked", () => {
    const fixedNow = withStatus("f1", "fixed", {
      runId: "r2",
      statusHistory: [
        { from: null, to: "new", runId: "r1", at: T1 },
        { from: "new", to: "fixed", runId: "r2", at: T2 },
      ],
    });
    const fixedEarlier = withStatus("f2", "fixed", {
      statusHistory: [
        { from: null, to: "new", runId: "r0", at: T1 },
        { from: "new", to: "fixed", runId: "r1", at: T1 },
      ],
    });
    const summary = summarizeRun(
      [
        withStatus("n", "new", { lastSeenRunId: "r2" }),
        withStatus("o", "open", { lastSeenRunId: "r2" }),
        withStatus("re", "reopened", { lastSeenRunId: "r2" }),
        withStatus("u", "unverified", { lastSeenRunId: "r2", verdict: "unverified" }),
        withStatus("stale", "open", { lastSeenRunId: "r1" }),
        fixedNow,
        fixedEarlier,
        withStatus("ign", "ignored", { lastSeenRunId: "r2" }),
      ],
      "r2",
    );
    expect(summary).toEqual({
      total: 8,
      failing: 3,
      unverified: 1,
      fixed: 2,
      new: 1,
      open: 1,
      reopened: 1,
      fixedSinceLast: 1,
      notRechecked: 1,
    });
  });

  it("is all zeros for an empty run", () => {
    expect(summarizeRun([], "r1")).toMatchObject({
      total: 0,
      failing: 0,
      fixed: 0,
      notRechecked: 0,
    });
  });
});

describe("link-structure problems and coverage", () => {
  const coverage = coverageOf({
    run: { settings: { categories: ["seo"] } },
    pages: [{ url: "https://site.test/p", status: 200, viewport: "desktop" }],
  } as never);
  const probe = (ruleId: string, viewport: "all" | "mobile") =>
    ({ ruleId, category: "seo", pageUrl: "https://site.test/p", viewport }) as never;

  it("needs just one look at the page, whatever the viewport", () => {
    expect(issueCovered(probe("nav.page.orphan", "all"), coverage)).toBe(true);
  });

  it("still needs both viewports for an ordinary 'all' problem", () => {
    expect(issueCovered(probe("seo.title.missing", "all"), coverage)).toBe(false);
  });

  it("does not call it covered when the page was not scanned at all", () => {
    const other = {
      ruleId: "nav.page.orphan",
      category: "seo",
      pageUrl: "https://site.test/x",
      viewport: "all",
    };
    expect(issueCovered(other as never, coverage)).toBe(false);
  });
});
