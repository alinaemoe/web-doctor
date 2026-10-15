import { SCHEMA_VERSION } from "@webdoctor/core/shared";
import type { Issue, Report } from "@webdoctor/core/shared";

const now = "2026-10-15T10:00:00.000Z";

function issue(
  partial: Partial<Issue> & Pick<Issue, "id" | "ruleId" | "title" | "pageUrl">,
): Issue {
  return {
    runId: "run-1",
    category: "seo",
    viewport: "all",
    severity: "medium",
    confidence: 1,
    verdict: "fail",
    status: "new",
    evidence: [
      {
        type: "dom",
        selector: "body > main",
        htmlSnippet: "<main>…</main>",
        boundingBox: { x: 100, y: 200, width: 500, height: 100 },
        nodeSignature: { domPath: "body > main" },
      },
    ],
    explanation: {
      what: `${partial.title} (what)`,
      where: `Page ${partial.pageUrl}`,
      why: "Because it matters.",
      howToFix: "Fix it like this.",
    },
    fix: { verifyCriterion: "It passes." },
    fingerprint: partial.id.padEnd(16, "0"),
    firstSeenRunId: "run-1",
    lastSeenRunId: "run-1",
    statusHistory: [{ from: null, to: "new", runId: "run-1", at: now }],
    ...partial,
  };
}

/**
 * Three pages (/a, /b, /c) share an h1 problem (a root-cause group); /a also has a console error
 * with a position, and there is one unverified external link without a position.
 */
export function fixtureReport(): Report {
  const h1 = (id: string, page: string) =>
    issue({
      id,
      ruleId: "seo.h1.missing",
      title: "Page has no <h1>",
      pageUrl: `http://site.test/${page}`,
      groupId: "g1",
    });

  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      id: "run-1",
      status: "completed",
      settings: {
        startUrl: "http://site.test/",
        maxPages: 10,
        maxDepth: 2,
        viewports: ["desktop", "mobile"],
        categories: ["seo", "runtime", "links-resources"],
        respectRobots: true,
      },
      scannerVersion: "0",
      startedAt: now,
      partial: false,
    },
    pages: ["a", "b", "c"].flatMap((p) =>
      (["desktop", "mobile"] as const).map((viewport) => ({
        url: `http://site.test/${p}`,
        finalUrl: `http://site.test/${p}`,
        status: 200,
        depth: 0,
        viewport,
        title: p,
        screenshotKey: `screenshots/${p}-${viewport}.webp`,
        screenshotTruncated: false,
      })),
    ),
    issues: [
      h1("h1-a", "a"),
      h1("h1-b", "b"),
      h1("h1-c", "c"),
      issue({
        id: "console-a",
        ruleId: "runtime.console.error",
        category: "runtime",
        severity: "high",
        title: "JavaScript error on the page",
        pageUrl: "http://site.test/a",
        evidence: [
          { type: "console", level: "pageerror", text: "boom" },
          {
            type: "dom",
            selector: "body > main > button",
            htmlSnippet: "<button>Buy</button>",
            boundingBox: { x: 50, y: 400, width: 200, height: 50 },
            nodeSignature: { domPath: "body > main > button" },
          },
        ],
      }),
      issue({
        id: "ext-a",
        ruleId: "link.external.broken",
        category: "links-resources",
        severity: "low",
        confidence: 0.4,
        verdict: "unverified",
        unverifiedReason: "rate_limited",
        status: "unverified",
        title: "External link could not be verified",
        pageUrl: "http://site.test/a",
        evidence: [
          {
            type: "network",
            requestUrl: "http://other.test/x",
            method: "GET",
            status: 429,
            resourceType: "document",
          },
        ],
      }),
    ],
    groups: [
      {
        id: "g1",
        runId: "run-1",
        ruleId: "seo.h1.missing",
        signature: "seo.h1.missing|dom|body > main",
        hypothesis: true,
        confidence: 0.6,
        issueIds: ["h1-a", "h1-b", "h1-c"],
        affectedPages: 3,
      },
    ],
  };
}
