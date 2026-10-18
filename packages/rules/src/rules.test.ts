import { describe, expect, it } from "vitest";
import type { ElementInfo, LinkCheck, PageSnapshot, ScanResult } from "@webdoctor/core";
import { analyze } from "./analyze";
import { isInactiveControl, summarizeFailure } from "./pageRules";

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

describe("axe findings are aggregated per rule and page", () => {
  const node = (target: string, html = `<div class="x"></div>`) => ({ target, html });
  const violation = (
    id: string,
    nodes: ReturnType<typeof node>[],
    impact: "serious" | "minor" = "serious",
  ) => ({
    id,
    impact,
    help: `Help for ${id}`,
    description: `Description of ${id}`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4/${id}`,
    tags: ["wcag2a"],
    nodes,
  });

  it("turns 300 failing elements of one rule into a single issue with the count", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`.item:nth-child(${i + 1})`));
    const { issues } = analyze(
      scanOf([page("http://site.test/", { axe: [violation("role-img-alt", nodes)] })]),
      { runId: "r" },
    );
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({ ruleId: "a11y.axe.role-img-alt", severity: "high" });
    expect(issue.explanation.what).toContain("300 elements on this page");
    expect(issue.evidence.find((e) => e.type === "metric")).toMatchObject({ value: 300 });
    // only a handful of examples are kept as evidence
    expect(issue.evidence.filter((e) => e.type === "dom")).toHaveLength(5);
  });

  it("keeps one issue per rule: two rules on a page are two issues", () => {
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", {
          axe: [violation("list", [node(".a")]), violation("label", [node(".b"), node(".c")])],
        }),
      ]),
      { runId: "r" },
    );
    expect(issues.map((i) => i.ruleId).sort()).toEqual(["a11y.axe.label", "a11y.axe.list"]);
  });

  it("keeps the identity when only some of the elements get fixed", () => {
    const before = analyze(
      scanOf([page("http://site.test/", { axe: [violation("list", [node(".a"), node(".b")])] })]),
      { runId: "r1" },
    ).issues[0]!;
    const after = analyze(
      scanOf([page("http://site.test/", { axe: [violation("list", [node(".b")])] })]),
      { runId: "r2" },
    ).issues[0]!;
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("groups one axe rule across pages into a single root-cause hypothesis", () => {
    const pages = ["a", "b", "c"].map((p) =>
      page(`http://site.test/${p}`, { axe: [violation("html-has-lang", [node("html")])] }),
    );
    const { issues, groups } = analyze(scanOf(pages), { runId: "r" });
    expect(issues).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ruleId: "a11y.axe.html-has-lang", affectedPages: 3 });
  });

  it("ignores a violation without nodes", () => {
    expect(
      analyze(scanOf([page("http://site.test/", { axe: [violation("list", [])] })]), { runId: "r" })
        .issues,
    ).toEqual([]);
  });
});

describe("noise that is not the site owner's to fix", () => {
  const img = (src: string, extra: Record<string, unknown> = {}) => ({
    ...el("img"),
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    src,
    hasAltAttr: true,
    hasWidthAttr: false,
    hasHeightAttr: false,
    naturalWidth: 10,
    complete: true,
    ...extra,
  });

  it("still reports an ordinary image without width/height", () => {
    const { issues } = analyze(
      scanOf([page("http://site.test/", { images: [img("http://site.test/a.png")] })]),
      { runId: "r" },
    );
    expect(issues.map((i) => i.ruleId)).toEqual(["runtime.img.no-dimensions"]);
  });

  it("skips images inside third-party widgets and inline data: images", () => {
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", {
          images: [
            img("https://maps.googleapis.com/maps/vt?x=1", { inWidget: true }),
            img("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"),
            img(""),
          ],
        }),
      ]),
      { runId: "r" },
    );
    expect(issues).toEqual([]);
  });

  it("ignores a couple of pixels of horizontal overflow on mobile but reports a real one", () => {
    const tiny = { scrollWidth: 392, clientWidth: 390, offenders: [] };
    const wide = { scrollWidth: 450, clientWidth: 390, offenders: [] };
    const off = analyze(
      scanOf([page("http://site.test/", { viewport: "mobile", overflowX: tiny })]),
      { runId: "r" },
    );
    expect(off.issues).toEqual([]);
    const on = analyze(
      scanOf([page("http://site.test/", { viewport: "mobile", overflowX: wide })]),
      { runId: "r" },
    );
    expect(on.issues[0]).toMatchObject({ ruleId: "runtime.overflow-x.mobile", severity: "medium" });
    const small = { scrollWidth: 400, clientWidth: 390, offenders: [] };
    const low = analyze(
      scanOf([page("http://site.test/", { viewport: "mobile", overflowX: small })]),
      { runId: "r" },
    );
    expect(low.issues[0]).toMatchObject({ severity: "low" });
  });
});

describe("summarizeFailure", () => {
  it("turns axe's bullet list into one readable sentence", () => {
    expect(
      summarizeFailure(
        "Fix any of the following:\n  aria-label attribute does not exist or is empty\n  Element has an empty title attribute",
      ),
    ).toBe(
      "Fix any of the following: aria-label attribute does not exist or is empty; Element has an empty title attribute.",
    );
    expect(summarizeFailure("Fix this one thing")).toBe("Fix this one thing");
    expect(summarizeFailure("")).toBeUndefined();
    expect(summarizeFailure(undefined)).toBeUndefined();
  });
});

describe("more noise that is not a real problem", () => {
  const contrast = (...nodes: { target: string; html: string }[]) => ({
    id: "color-contrast",
    impact: "serious" as const,
    help: "Contrast",
    description: "d",
    helpUrl: "https://example.test/contrast",
    tags: [],
    nodes,
  });

  it("recognizes disabled controls by attribute, aria-disabled or class", () => {
    expect(isInactiveControl('<button disabled class="x">Send</button>')).toBe(true);
    expect(isInactiveControl('<button class="button-send disabled">SEND</button>')).toBe(true);
    expect(isInactiveControl('<a aria-disabled="true" href="/x">Go</a>')).toBe(true);
    expect(isInactiveControl('<button class="btn is-disabled">x</button>')).toBe(true);
    expect(isInactiveControl('<button class="btn disabled-look-alike">x</button>')).toBe(false);
    expect(isInactiveControl("<p>disabled people</p>")).toBe(false);
    expect(isInactiveControl('<button class="go">Pay</button>')).toBe(false);
  });

  it("does not report low contrast on disabled controls, but still on active ones", () => {
    const { issues } = analyze(
      scanOf([
        page("http://site.test/", {
          axe: [
            contrast(
              { target: ".send", html: '<button class="send disabled">SEND</button>' },
              { target: ".buy", html: '<a class="buy" href="/buy">BUY</a>' },
            ),
          ],
        }),
      ]),
      { runId: "r" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.explanation.what).toContain("1 element on this page");
    // a page whose only low-contrast element is disabled has nothing to report
    expect(
      analyze(
        scanOf([
          page("http://site.test/", {
            axe: [contrast({ target: ".send", html: "<button disabled>SEND</button>" })],
          }),
        ]),
        { runId: "r" },
      ).issues,
    ).toEqual([]);
  });

  it("skips map tiles from any provider", () => {
    const img = (src: string) => ({
      ...el("img"),
      boundingBox: { x: 0, y: 0, width: 256, height: 256 },
      src,
      hasAltAttr: true,
      hasWidthAttr: false,
      hasHeightAttr: false,
      naturalWidth: 256,
      complete: true,
    });
    const tiles = [
      "https://api.mapbox.com/styles/v1/u/s/tiles/256/15/1/2",
      "https://tile.openstreetmap.org/15/1/2.png",
      "https://a.tile.example.com/15/1/2.png",
      "https://maps.gstatic.com/mapfiles/x.png",
    ];
    const { issues } = analyze(scanOf([page("http://site.test/", { images: tiles.map(img) })]), {
      runId: "r",
    });
    expect(issues).toEqual([]);
  });
});
