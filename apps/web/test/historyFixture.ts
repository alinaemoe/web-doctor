import { SCHEMA_VERSION } from "@webdoctor/core/shared";
import type { Issue, Report, RunSummary } from "@webdoctor/core/shared";

const T1 = "2026-10-20T10:00:00.000Z";
const T2 = "2026-10-21T10:00:00.000Z";

const base = (partial: Partial<Issue> & Pick<Issue, "id" | "title" | "pageUrl">): Issue => ({
  runId: "run-2",
  ruleId: "seo.h1.missing",
  category: "seo",
  viewport: "all",
  severity: "medium",
  confidence: 1,
  verdict: "fail",
  status: "open",
  evidence: [{ type: "console", level: "error", text: "x" }],
  explanation: { what: `${partial.title} (what)`, where: "w", why: "w", howToFix: "h" },
  fingerprint: partial.id.padEnd(16, "0"),
  firstSeenRunId: "run-1",
  lastSeenRunId: "run-2",
  statusHistory: [{ from: null, to: "new", runId: "run-1", at: T1 }],
  ...partial,
});

export const historySummary: RunSummary = {
  total: 6,
  failing: 3,
  unverified: 0,
  fixed: 2,
  new: 1,
  open: 1,
  reopened: 1,
  fixedSinceLast: 1,
  notRechecked: 1,
};

/**
 * Run 2, compared with run 1: one new problem, one that came back, one still open, one fixed since
 * the last run, one fixed long ago, and one known from run 1 whose page was not rechecked.
 */
export function historyReport(): Report {
  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: "run-2",
      status: "completed",
      settings: {
        startUrl: "http://site.test/",
        maxPages: 10,
        maxDepth: 2,
        viewports: ["desktop"],
        categories: ["seo"],
        respectRobots: true,
      },
      scannerVersion: "0",
      startedAt: T2,
      partial: false,
      previousRunId: "run-1",
      summary: historySummary,
    },
    pages: [
      {
        url: "http://site.test/a",
        finalUrl: "http://site.test/a",
        status: 200,
        depth: 0,
        viewport: "desktop",
        title: "a",
        screenshotKey: "screenshots/a-desktop.webp",
        screenshotTruncated: false,
      },
    ],
    issues: [
      base({
        id: "fresh",
        title: "Fresh problem",
        pageUrl: "http://site.test/a",
        status: "new",
        firstSeenRunId: "run-2",
        statusHistory: [{ from: null, to: "new", runId: "run-2", at: T2 }],
      }),
      base({
        id: "back",
        title: "Problem that came back",
        pageUrl: "http://site.test/a",
        status: "reopened",
        statusHistory: [
          { from: null, to: "new", runId: "run-0", at: "2026-10-19T10:00:00.000Z" },
          {
            from: "new",
            to: "fixed",
            runId: "run-1",
            at: T1,
            reason: "Not found when the page was scanned again",
          },
          {
            from: "fixed",
            to: "reopened",
            runId: "run-2",
            at: T2,
            reason: "Found again after it was fixed",
          },
        ],
      }),
      base({ id: "still", title: "Still open problem", pageUrl: "http://site.test/a" }),
      base({
        id: "gone",
        title: "Problem fixed since last run",
        pageUrl: "http://site.test/a",
        status: "fixed",
        lastSeenRunId: "run-1",
        statusHistory: [
          { from: null, to: "new", runId: "run-1", at: T1 },
          {
            from: "new",
            to: "fixed",
            runId: "run-2",
            at: T2,
            reason: "Not found when the page was scanned again",
          },
        ],
      }),
      base({
        id: "old-fix",
        title: "Problem fixed long ago",
        pageUrl: "http://site.test/a",
        status: "fixed",
        lastSeenRunId: "run-0",
        statusHistory: [
          { from: null, to: "new", runId: "run-0", at: "2026-10-19T10:00:00.000Z" },
          { from: "new", to: "fixed", runId: "run-1", at: T1 },
        ],
      }),
      base({
        id: "unseen",
        title: "Problem on a page nobody looked at",
        pageUrl: "http://site.test/elsewhere",
        status: "open",
        lastSeenRunId: "run-1",
      }),
    ],
    groups: [],
  };
}
