import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { toCsv, toHtml } from "./reports";

const evil = "<script>alert(1)</script>";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    runId: "r1",
    ruleId: "seo.title.missing",
    category: "seo",
    pageUrl: "http://site.test/",
    viewport: "all",
    title: "Page has no title",
    severity: "high",
    confidence: 1,
    verdict: "fail",
    status: "new",
    evidence: [
      {
        type: "dom",
        selector: "head > title",
        htmlSnippet: evil,
        nodeSignature: { domPath: "head > title" },
      },
    ],
    explanation: { what: evil, where: "Page /", why: "w", howToFix: "h" },
    fingerprint: "0123456789abcdef",
    firstSeenRunId: "r1",
    lastSeenRunId: "r1",
    statusHistory: [{ from: null, to: "new", runId: "r1", at: "2026-10-15T10:00:00.000Z" }],
    ...overrides,
  };
}

const report = (issues: Issue[]): Report => ({
  schemaVersion: SCHEMA_VERSION,
  run: {
    id: "r1",
    status: "completed",
    settings: {
      startUrl: "http://site.test/",
      maxPages: 5,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["seo"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt: "2026-10-15T10:00:00.000Z",
    partial: false,
  },
  pages: [],
  issues,
  groups: [],
});

describe("toCsv", () => {
  it("escapes quotes, commas and newlines", () => {
    const csv = toCsv([issue({ title: 'He said "hi", ok\nbye' })]);
    expect(csv).toContain('"He said ""hi"", ok\nbye"');
  });

  it("neutralizes spreadsheet formulas coming from scanned sites", () => {
    const csv = toCsv([issue({ title: '=HYPERLINK("http://evil")' })]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("has a header and one row per issue", () => {
    const lines = toCsv([issue(), issue({ id: "i2" })])
      .trimEnd()
      .split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^id,ruleId,category/);
  });
});

describe("toHtml", () => {
  it("escapes content that comes from scanned pages", () => {
    const html = toHtml(report([issue()]));
    expect(html).not.toContain(evil);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("lists unverified issues separately and keeps the WCAG disclaimer", () => {
    const html = toHtml(
      report([
        issue({
          id: "u",
          verdict: "unverified",
          unverifiedReason: "rate_limited",
          status: "unverified",
        }),
      ]),
    );
    expect(html).toContain("Couldn't verify");
    expect(html).toContain("rate_limited");
    expect(html).toContain("only part of accessibility");
  });

  it("marks partial runs", () => {
    const r = report([]);
    r.run.partial = true;
    r.run.stopReason = "max-pages";
    expect(toHtml(r)).toContain("Partial result (max-pages)");
  });
});
