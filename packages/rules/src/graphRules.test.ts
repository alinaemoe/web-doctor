import { describe, expect, it } from "vitest";
import type { PageSnapshot, ScanResult } from "@webdoctor/core";
import { analyze } from "./analyze";

const O = "https://site.test";
const page = (path: string, links: string[]): PageSnapshot =>
  ({
    url: `${O}${path}`,
    finalUrl: `${O}${path}`,
    status: 200,
    viewport: "desktop",
    depth: 0,
    links: links.map((l) => ({
      href: `${O}${l}`,
      text: "x",
      selector: "a",
      htmlSnippet: "<a>",
      nodeSignature: { domPath: "a" },
    })),
    h1s: [{ selector: "h1", htmlSnippet: "<h1>", nodeSignature: { domPath: "h1" } }],
    images: [],
    network: [],
    console: [],
    axe: [],
    title: "T",
    metaDescription: "D",
    canonical: null,
    robotsMeta: null,
    htmlLang: "en",
    mainElement: { selector: "main", htmlSnippet: "<main>", nodeSignature: { domPath: "main" } },
    overflowX: { scrollWidth: 100, clientWidth: 100, offenders: [] },
    headers: {},
    loadedAt: "2026-10-19T00:00:00.000Z",
    fullHeight: 100,
    screenshotTruncated: false,
  }) as unknown as PageSnapshot;

const scanOf = (pages: PageSnapshot[], partial = false): ScanResult =>
  ({
    origin: O,
    startUrl: `${O}/`,
    partial,
    skipped: [],
    pages,
    linkChecks: {},
    robots: { url: `${O}/robots.txt` },
    sitemap: { url: `${O}/sitemap.xml`, locs: [`${O}/hidden`], declaredInRobots: false },
  }) as unknown as ScanResult;

const chain = (n: number) =>
  Array.from({ length: n }, (_, i) => page(`/c${i}`, i + 1 < n ? [`/c${i + 1}`] : ["/"]));

const nav = (scan: ScanResult) =>
  analyze(scan, { runId: "r" }).issues.filter((i) => i.ruleId.startsWith("nav."));

describe("page connection rules", () => {
  it("reports a page that no link path reaches (orphan) as a failure on a complete scan", () => {
    const issues = nav(scanOf([page("/", ["/a"]), page("/a", ["/"]), page("/hidden", ["/a"])]));
    const orphan = issues.find((i) => i.ruleId === "nav.page.orphan")!;
    expect(orphan).toMatchObject({ pageUrl: `${O}/hidden`, verdict: "fail", viewport: "all" });
    expect(orphan.evidence[0]).toMatchObject({ type: "metric", name: "inbound-links", value: 0 });
    expect(orphan.explanation.what).toContain("sitemap");
    expect(issues.filter((i) => i.ruleId === "nav.page.orphan")).toHaveLength(1);
  });

  it("is only 'could not be sure' when the scan was partial", () => {
    const issues = nav(
      scanOf([page("/", ["/a"]), page("/a", ["/"]), page("/hidden", ["/a"])], true),
    );
    const orphan = issues.find((i) => i.ruleId === "nav.page.orphan")!;
    expect(orphan).toMatchObject({
      verdict: "unverified",
      unverifiedReason: "needs_manual_review",
    });
    expect(orphan.confidence).toBeLessThan(0.5);
    expect(orphan.explanation.what).toContain("Not every page");
  });

  it("reports pages five or more clicks from the home page, with the number", () => {
    const pages = [page("/", ["/c0"]), ...chain(6)];
    const deep = nav(scanOf(pages)).filter((i) => i.ruleId === "nav.page.deep");
    expect(deep.map((i) => i.pageUrl).sort()).toEqual([`${O}/c4`, `${O}/c5`]);
    expect(deep[0]!.evidence[0]).toMatchObject({ name: "click-depth" });
    const c5 = deep.find((i) => i.pageUrl === `${O}/c5`)!;
    expect(c5.explanation.what).toContain("6 clicks");
  });

  it("does not call a page 4 clicks away deep", () => {
    const deep = nav(scanOf([page("/", ["/c0"]), ...chain(4)])).filter(
      (i) => i.ruleId === "nav.page.deep",
    );
    expect(deep).toEqual([]);
  });

  it("reports pages without links as dead ends, but not on a one-page site", () => {
    const some = nav(scanOf([page("/", ["/end"]), page("/end", []), page("/hidden", ["/"])]));
    expect(some.filter((i) => i.ruleId === "nav.page.dead-end").map((i) => i.pageUrl)).toEqual([
      `${O}/end`,
    ]);
    expect(nav(scanOf([page("/", [])]))).toEqual([]);
  });

  it("groups the same problem on several pages into one root cause", () => {
    const pages = [
      page("/", ["/a", "/b", "/c"]),
      page("/a", []),
      page("/b", []),
      page("/c", []),
      page("/hidden", ["/"]),
    ];
    const { groups } = analyze(scanOf(pages), { runId: "r" });
    expect(groups.some((g) => g.ruleId === "nav.page.dead-end" && g.affectedPages === 3)).toBe(
      true,
    );
  });

  it("keeps the fingerprint of an orphan stable between runs", () => {
    const scan = scanOf([page("/", ["/a"]), page("/a", ["/"]), page("/hidden", [])]);
    const once = nav(scan)
      .map((i) => i.fingerprint)
      .sort();
    const twice = nav(scan)
      .map((i) => i.fingerprint)
      .sort();
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(once.length);
  });
});
