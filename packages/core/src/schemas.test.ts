import { describe, expect, it } from "vitest";
import { IssueSchema, ReportSchema, SCHEMA_VERSION } from "./schemas";
import { priorityScore } from "./priority";

const issue = {
  id: "i1",
  runId: "r1",
  ruleId: "res.img.failed",
  category: "links-resources",
  pageUrl: "http://localhost:4000/products/backpack",
  viewport: "desktop",
  title: "Product image failed to load",
  severity: "high",
  confidence: 1,
  verdict: "fail",
  status: "new",
  evidence: [
    {
      type: "network",
      requestUrl: "http://localhost:4000/img/backpack-missing.jpg",
      method: "GET",
      status: 404,
      resourceType: "image",
    },
  ],
  explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
  fingerprint: "0123456789abcdef",
  firstSeenRunId: "r1",
  lastSeenRunId: "r1",
  statusHistory: [{ from: null, to: "new", runId: "r1", at: "2026-10-15T10:00:00.000Z" }],
};

describe("IssueSchema", () => {
  it("accepts a valid issue", () => {
    expect(IssueSchema.safeParse(issue).success).toBe(true);
  });

  it("rejects an issue without evidence", () => {
    expect(IssueSchema.safeParse({ ...issue, evidence: [] }).success).toBe(false);
  });

  it("rejects `pass` as a verdict and out-of-range confidence", () => {
    expect(IssueSchema.safeParse({ ...issue, verdict: "pass" }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...issue, confidence: 1.5 }).success).toBe(false);
  });
});

describe("ReportSchema", () => {
  it("validates a minimal report", () => {
    const report = {
      schemaVersion: SCHEMA_VERSION,
      run: {
        id: "r1",
        status: "completed",
        settings: {
          startUrl: "http://localhost:4000/",
          maxPages: 50,
          maxDepth: 3,
          viewports: ["desktop", "mobile"],
          categories: ["seo"],
          respectRobots: true,
        },
        scannerVersion: "0.0.0",
        startedAt: "2026-10-15T10:00:00.000Z",
        partial: false,
      },
      pages: [],
      issues: [issue],
      groups: [],
    };
    expect(ReportSchema.safeParse(report).success).toBe(true);
    expect(ReportSchema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
  });
});

describe("priorityScore", () => {
  it("scales with severity, confidence and affected pages", () => {
    expect(priorityScore("high", 1, 1).score).toBe(60);
    expect(priorityScore("high", 0.5, 1).score).toBe(30);
    expect(priorityScore("high", 1, 8).score).toBe(240);
    expect(priorityScore("high", 1, 0).score).toBe(60);
  });

  it("ranks a widespread medium issue above a single low one", () => {
    expect(priorityScore("medium", 0.9, 18).score).toBeGreaterThan(
      priorityScore("low", 1, 1).score,
    );
  });
});
