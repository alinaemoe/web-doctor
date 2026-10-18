import { describe, expect, it } from "vitest";
import { computeFingerprint } from "@webdoctor/core";
import type { Issue, PageSnapshot, Verification } from "@webdoctor/core";
import { applyVerification, sampleGroupMembers } from "./apply";
import { signatureScore, verifyIssues } from "./verify";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    runId: "r1",
    ruleId: "seo.title.missing",
    category: "seo",
    pageUrl: "http://site.test/a",
    viewport: "desktop",
    title: "Page has no title",
    severity: "high",
    confidence: 1,
    verdict: "fail",
    status: "new",
    evidence: [
      {
        type: "dom",
        selector: "head > title",
        htmlSnippet: "(none)",
        nodeSignature: { domPath: "head > title" },
      },
    ],
    explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
    // what the rules compute for this exact problem, so a re-check recognizes it
    fingerprint: computeFingerprint({
      ruleId: "seo.title.missing",
      pageUrl: "http://site.test/a",
      elementKey: "path:head > title",
    }),
    firstSeenRunId: "r1",
    lastSeenRunId: "r1",
    statusHistory: [{ from: null, to: "new", runId: "r1", at: "2026-10-16T09:00:00.000Z" }],
    ...overrides,
  };
}

const verification = (outcome: Verification["outcome"]): Verification => ({
  issueId: "i1",
  outcome,
  detail: "d",
  checkedAt: "2026-10-16T10:00:00.000Z",
  confidence: 1,
  pages: [],
});

describe("signatureScore", () => {
  it("weights id above accessible name above DOM path", () => {
    expect(signatureScore({ id: "x" }, { id: "x" })).toBe(3);
    expect(signatureScore({ accessibleName: " Buy Now " }, { accessibleName: "buy now" })).toBe(2);
    expect(signatureScore({ domPath: "a > b" }, { domPath: "a > b" })).toBe(1);
    expect(
      signatureScore(
        { id: "x", accessibleName: "n", domPath: "p" },
        { id: "x", accessibleName: "n", domPath: "p" },
      ),
    ).toBe(6);
  });

  it("does not match different elements or conflicting roles", () => {
    expect(signatureScore({ id: "a" }, { id: "b" })).toBe(0);
    expect(
      signatureScore(
        { role: "button", accessibleName: "Go" },
        { role: "link", accessibleName: "Go" },
      ),
    ).toBe(0);
    expect(signatureScore({}, {})).toBe(0);
  });
});

describe("applyVerification", () => {
  it("marks verified-fixed issues fixed and records why", () => {
    const next = applyVerification(issue(), verification("verified-fixed"));
    expect(next.status).toBe("fixed");
    expect(next.statusHistory.at(-1)).toMatchObject({ from: "new", to: "fixed" });
    expect(next.statusHistory.at(-1)!.reason).toContain("Re-verified");
  });

  it("never changes an issue because a check was unverified or still failing", () => {
    const base = issue();
    expect(applyVerification(base, verification("unverified"))).toBe(base);
    expect(applyVerification(base, verification("still-failing"))).toBe(base);
  });

  it("reopens a fixed issue that fails again and leaves ignored issues alone", () => {
    expect(
      applyVerification(issue({ status: "fixed" }), verification("still-failing")).status,
    ).toBe("reopened");
    const ignored = issue({ status: "ignored" });
    expect(applyVerification(ignored, verification("verified-fixed"))).toBe(ignored);
  });
});

describe("sampleGroupMembers", () => {
  const members = ["a", "b", "c", "d"].flatMap((p) => [
    issue({ id: `${p}1`, pageUrl: `http://site.test/${p}` }),
    issue({ id: `${p}2`, pageUrl: `http://site.test/${p}` }),
  ]);

  it("takes one issue per page and respects the limit", () => {
    const sample = sampleGroupMembers(members, 3);
    expect(sample).toHaveLength(3);
    expect(new Set(sample.map((s) => s.pageUrl)).size).toBe(3);
  });

  it("prefers unresolved issues over fixed ones", () => {
    const withFixed = members.map((m) =>
      m.pageUrl.endsWith("/a") ? { ...m, status: "fixed" as const } : m,
    );
    const sample = sampleGroupMembers(withFixed, 3);
    expect(sample.every((s) => s.status !== "fixed")).toBe(true);
  });
});

describe("verifyIssues without a browser (injected collection)", () => {
  const snapshot = (overrides: Partial<PageSnapshot>): PageSnapshot => ({
    url: "http://site.test/a",
    finalUrl: "http://site.test/a",
    status: 200,
    depth: 0,
    viewport: "desktop",
    loadedAt: "2026-10-16T10:00:00.000Z",
    headers: {},
    title: "Now it has a title",
    metaDescription: "d",
    canonical: null,
    robotsMeta: null,
    htmlLang: "en",
    mainElement: null,
    h1s: [{ selector: "h1", htmlSnippet: "<h1>", nodeSignature: { domPath: "h1" } }],
    images: [],
    links: [],
    overflowX: { scrollWidth: 1, clientWidth: 1, offenders: [] },
    network: [],
    console: [],
    axe: [],
    fullHeight: 1,
    screenshotTruncated: false,
    ...overrides,
  });

  it("reports a fix as verified-fixed", async () => {
    const [v] = await verifyIssues([issue()], {
      collect: async () => ({ ok: true, snapshot: snapshot({}) }),
    });
    expect(v).toMatchObject({ outcome: "verified-fixed", confidence: 1 });
  });

  it("reports an unloadable page as unverified, never as fixed", async () => {
    const [v] = await verifyIssues([issue()], {
      collect: async () => ({
        ok: false,
        reason: "navigation-error",
        detail: "net::ERR_CONNECTION_REFUSED",
      }),
    });
    expect(v).toMatchObject({ outcome: "unverified", reason: "page_unreachable", confidence: 0 });
    expect(v!.detail).toContain("ERR_CONNECTION_REFUSED");
  });

  it("reports an error page as unverified", async () => {
    const [v] = await verifyIssues([issue()], {
      collect: async () => ({ ok: true, snapshot: snapshot({ status: 503 }) }),
    });
    expect(v).toMatchObject({ outcome: "unverified", reason: "page_unreachable" });
  });

  it("checks both viewports of an 'all' issue and fails if either still fails", async () => {
    const seen: string[] = [];
    const [v] = await verifyIssues([issue({ viewport: "all" })], {
      collect: async (_url, viewport) => {
        seen.push(viewport);
        return {
          ok: true,
          snapshot: snapshot({ viewport, title: viewport === "mobile" ? null : "ok" }),
        };
      },
    });
    expect(seen.sort()).toEqual(["desktop", "mobile"]);
    expect(v).toMatchObject({ outcome: "still-failing" });
    expect(v!.pages.map((p) => p.viewport).sort()).toEqual(["desktop", "mobile"]);
  });

  it("loads a shared page once for several issues", async () => {
    let calls = 0;
    await verifyIssues(
      [issue({ id: "i1" }), issue({ id: "i2", ruleId: "seo.description.missing" })],
      {
        collect: async () => {
          calls++;
          return { ok: true, snapshot: snapshot({}) };
        },
      },
    );
    expect(calls).toBe(1);
  });

  it("flags a fix where the original element is gone", async () => {
    const dom = {
      type: "dom" as const,
      selector: "body > main > h1",
      htmlSnippet: "<h1>",
      nodeSignature: { domPath: "body > main > h1" },
    };
    const [v] = await verifyIssues([issue({ evidence: [dom] })], {
      collect: async () => ({
        ok: true,
        snapshot: snapshot({ probes: { "body > main > h1": false } }),
      }),
    });
    expect(v).toMatchObject({ outcome: "verified-fixed", elementGone: true });
    expect(v!.confidence).toBeLessThan(1);
  });

  it("reports a partial fix of an aggregated finding with the remaining count", async () => {
    const dom = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: "dom" as const,
        selector: `.item-${i}`,
        htmlSnippet: "<div>",
        nodeSignature: { domPath: `.item-${i}` },
      }));
    const metric = (n: number) => ({
      type: "metric" as const,
      name: "affectedElements",
      value: n,
      threshold: 0,
      unit: "elements",
    });
    const axe = (n: number) => ({
      id: "list",
      impact: "serious" as const,
      help: "Lists",
      description: "d",
      helpUrl: "https://example.test/list",
      tags: [],
      nodes: Array.from({ length: n }, (_, i) => ({ target: `.item-${i}`, html: "<ul>" })),
    });
    const fingerprint = computeFingerprint({
      ruleId: "a11y.axe.list",
      pageUrl: "http://site.test/a",
      elementKey: "axe",
      evidenceKey: "",
    });
    const old = issue({
      ruleId: "a11y.axe.list",
      category: "accessibility",
      fingerprint,
      evidence: [metric(10), ...dom(3)],
    });

    const [partly] = await verifyIssues([old], {
      collect: async () => ({ ok: true, snapshot: snapshot({ axe: [axe(4)] }) }),
    });
    expect(partly).toMatchObject({ outcome: "still-failing" });
    expect(partly!.detail).toBe("Partly fixed: 4 of the 10 elements still have the problem.");

    const [done] = await verifyIssues([old], {
      collect: async () => ({ ok: true, snapshot: snapshot({ axe: [] }) }),
    });
    expect(done).toMatchObject({ outcome: "verified-fixed" });
  });
});
