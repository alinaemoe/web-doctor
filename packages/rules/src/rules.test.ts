import { describe, expect, it } from "vitest";
import type { ElementInfo, LinkCheck, PageSnapshot, ScanResult } from "@webdoctor/core";
import { analyze } from "./analyze";

const el = (selector: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({
  selector,
  htmlSnippet: `<${selector}>`,
  nodeSignature: { domPath: selector },
  ...extra,
});

function page(url: string, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 0,
    viewport: "desktop",
    loadedAt: "2026-10-15T10:00:00.000Z",
    headers: {},
    title: "T",
    metaDescription: "D",
    canonical: null,
    robotsMeta: null,
    htmlLang: "en",
    mainElement: el("body > main"),
    h1s: [el("h1")],
    images: [],
    links: [],
    overflowX: { scrollWidth: 390, clientWidth: 390, offenders: [] },
    network: [],
    console: [],
    axe: [],
    fullHeight: 800,
    screenshotTruncated: false,
    ...overrides,
  };
}

function scanOf(pages: PageSnapshot[], linkChecks: Record<string, LinkCheck> = {}): ScanResult {
  return {
    scannerVersion: "test",
    startUrl: "http://site.test/",
    origin: "http://site.test",
    startedAt: "2026-10-15T10:00:00.000Z",
    finishedAt: "2026-10-15T10:01:00.000Z",
    partial: false,
    pages,
    skipped: [],
    linkChecks,
    robots: { url: "http://site.test/robots.txt", status: 404 },
    sitemap: {
      url: "http://site.test/sitemap.xml",
      status: 404,
      locs: [],
      declaredInRobots: false,
    },
  };
}

const check = (url: string, partial: Partial<LinkCheck>): LinkCheck => ({
  url,
  chain: [],
  loop: false,
  tooManyHops: false,
  ...partial,
});

const link = (href: string, selector = "footer > a") => ({
  ...el(selector),
  href,
  text: "link",
});

describe("analyze", () => {
  it("reports a clean page as having no issues", () => {
    expect(analyze(scanOf([page("http://site.test/")]), { runId: "r" }).issues).toEqual([]);
  });

  it("flags missing title/description/h1 with evidence on every issue", () => {
    const { issues } = analyze(
      scanOf([page("http://site.test/", { title: null, metaDescription: null, h1s: [] })]),
      { runId: "r" },
    );
    expect(issues.map((i) => i.ruleId).sort()).toEqual([
      "seo.description.missing",
      "seo.h1.missing",
      "seo.title.missing",
    ]);
    for (const i of issues) {
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(i.explanation.howToFix).not.toBe("");
    }
  });

  it("reports multiple h1 as a low-confidence hint", () => {
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", { h1s: [el("h1:nth-of-type(1)"), el("h1:nth-of-type(2)")] }),
      ]),
      { runId: "r" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: "seo.h1.multiple",
      severity: "low",
      confidence: 0.5,
    });
  });

  it("never calls a 429/403/timeout external link broken", () => {
    const external = "http://other.test/x";
    for (const [partial, reason] of [
      [{ status: 429 }, "rate_limited"],
      [{ status: 403 }, "blocked"],
      [{ error: "timeout" as const }, "timeout"],
      [{ error: "dns" as const }, "dns"],
    ] as const) {
      const { issues } = analyze(
        scanOf([page("http://site.test/", { links: [link(external)] })], {
          [external]: check(external, partial),
        }),
        { runId: "r" },
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        ruleId: "link.external.broken",
        verdict: "unverified",
        unverifiedReason: reason,
        status: "unverified",
      });
    }
  });

  it("reports an external 404 as a real failure", () => {
    const external = "http://other.test/gone";
    const { issues } = analyze(
      scanOf([page("http://site.test/", { links: [link(external)] })], {
        [external]: check(external, { status: 404 }),
      }),
      { runId: "r" },
    );
    expect(issues[0]).toMatchObject({ ruleId: "link.external.broken", verdict: "fail" });
  });

  it("separates a failing resource on a 200 page from page errors", () => {
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", {
          network: [
            {
              url: "http://site.test/a.jpg",
              method: "GET",
              resourceType: "image",
              status: 404,
              redirectChain: [],
            },
            {
              url: "http://site.test/b.js",
              method: "GET",
              resourceType: "script",
              redirectChain: [],
              errorText: "net::ERR_ABORTED",
            },
          ],
        }),
      ]),
      { runId: "r" },
    );
    expect(issues.map((i) => i.ruleId)).toEqual(["res.img.failed"]);
  });

  it("merges the same problem seen on desktop and mobile into viewport 'all'", () => {
    const network = [
      {
        url: "http://site.test/a.jpg",
        method: "GET",
        resourceType: "image",
        status: 404,
        redirectChain: [],
      },
    ];
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", { viewport: "desktop", network }),
        page("http://site.test/", { viewport: "mobile", network }),
      ]),
      { runId: "r" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.viewport).toBe("all");
  });

  it("groups one problem shared by several pages into a root-cause hypothesis", () => {
    const pages = ["a", "b", "c"].map((p) => page(`http://site.test/${p}`, { h1s: [] }));
    const { issues, groups } = analyze(scanOf(pages), { runId: "r" });
    expect(issues).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      ruleId: "seo.h1.missing",
      affectedPages: 3,
      hypothesis: true,
    });
    expect(issues.every((i) => i.groupId === groups[0]!.id)).toBe(true);
  });

  it("does not group a problem that occurs only once", () => {
    const { groups } = analyze(scanOf([page("http://site.test/", { h1s: [] })]), { runId: "r" });
    expect(groups).toEqual([]);
  });

  it("keeps fingerprints stable between runs and distinct between pages", () => {
    const run = (runId: string) =>
      analyze(
        scanOf([page("http://site.test/a", { h1s: [] }), page("http://site.test/b", { h1s: [] })]),
        {
          runId,
        },
      ).issues.map((i) => i.fingerprint);
    const first = run("r1");
    expect(run("r2")).toEqual(first);
    expect(new Set(first).size).toBe(2);
  });

  it("flags canonical pointing to a 404 and ignores cross-origin canonicals", () => {
    const gone = "http://site.test/gone";
    const { issues } = analyze(
      scanOf([page("http://site.test/", { canonical: "/gone" })], {
        [gone]: check(gone, { status: 404 }),
      }),
      { runId: "r" },
    );
    expect(issues.map((i) => i.ruleId)).toEqual(["seo.canonical.invalid"]);

    const foreign = "http://elsewhere.test/p";
    expect(
      analyze(
        scanOf([page("http://site.test/", { canonical: foreign })], {
          [foreign]: check(foreign, { status: 404 }),
        }),
        { runId: "r" },
      ).issues,
    ).toEqual([]);
  });

  it("reports mobile-only horizontal overflow, not on desktop", () => {
    const wide = { scrollWidth: 900, clientWidth: 390, offenders: [el("div.wide")] };
    const mobile = analyze(
      scanOf([page("http://site.test/", { viewport: "mobile", overflowX: wide })]),
      { runId: "r" },
    );
    expect(mobile.issues.map((i) => i.ruleId)).toEqual(["runtime.overflow-x.mobile"]);
    const desktop = analyze(
      scanOf([page("http://site.test/", { viewport: "desktop", overflowX: wide })]),
      { runId: "r" },
    );
    expect(desktop.issues).toEqual([]);
  });

  it("limits output to the requested categories", () => {
    const { issues } = analyze(scanOf([page("http://site.test/", { title: null, h1s: [] })]), {
      runId: "r",
      categories: ["runtime"],
    });
    expect(issues).toEqual([]);
  });
});
