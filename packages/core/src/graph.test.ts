import { describe, expect, it } from "vitest";
import { buildPageGraph, inboundByUrl } from "./graph";
import type { LinkCheck, PageSnapshot, ScanResult } from "./snapshot";

const O = "https://site.test";
const page = (path: string, links: string[], viewport: "desktop" | "mobile" = "desktop") =>
  ({
    url: `${O}${path}`,
    finalUrl: `${O}${path}`,
    status: 200,
    viewport,
    links: links.map((href) => ({ href: href.startsWith("http") ? href : `${O}${href}` })),
  }) as unknown as PageSnapshot;

function scanOf(
  pages: PageSnapshot[],
  extra: Omit<Partial<ScanResult>, "sitemap"> & {
    sitemap?: string[];
    checks?: Record<string, LinkCheck>;
  } = {},
): ScanResult {
  const { sitemap = [], checks = {}, ...rest } = extra;
  return {
    origin: O,
    startUrl: `${O}/`,
    partial: false,
    skipped: [],
    pages,
    linkChecks: checks,
    sitemap: {
      url: `${O}/sitemap.xml`,
      locs: sitemap.map((p) => `${O}${p}`),
      declaredInRobots: false,
    },
    ...rest,
  } as unknown as ScanResult;
}

const node = (g: ReturnType<typeof buildPageGraph>, path: string) =>
  g.nodes.find((n) => n.url === `${O}${path}`)!;

describe("buildPageGraph", () => {
  const graph = buildPageGraph(
    scanOf(
      [
        page("/", ["/a", "/b", "/logo.png", "https://elsewhere.test/x", "/#top"]),
        page("/a", ["/c", "/"]),
        page("/b", ["/a"]),
        page("/c", ["/d"]),
        page("/d", ["/e"]),
        page("/e", ["/f"]),
        page("/f", []),
        page("/orphan", ["/a"]),
      ],
      { sitemap: ["/orphan", "/a", "/not-scanned"] },
    ),
  );

  it("counts clicks from the home page", () => {
    expect(node(graph, "/").depth).toBe(0);
    expect(node(graph, "/a").depth).toBe(1);
    expect(node(graph, "/f").depth).toBe(5);
    expect(node(graph, "/orphan").depth).toBeUndefined();
  });

  it("counts distinct inbound and outbound pages and ignores assets, other sites and self-links", () => {
    expect(node(graph, "/a")).toMatchObject({ inbound: 3, outbound: 2 });
    expect(node(graph, "/f")).toMatchObject({ inbound: 1, outbound: 0 });
    expect(node(graph, "/orphan")).toMatchObject({ inbound: 0, scanned: true, inSitemap: true });
    expect(graph.nodes.some((n) => /logo\.png|elsewhere/.test(n.url))).toBe(false);
    expect(node(graph, "/")).toMatchObject({ outbound: 2 });
  });

  it("knows pages that are only known from the sitemap", () => {
    expect(node(graph, "/not-scanned")).toMatchObject({
      scanned: false,
      inSitemap: true,
      inbound: 0,
    });
  });

  it("finds bottlenecks: pages that everything behind them depends on", () => {
    expect(node(graph, "/c").dominates).toBe(3); // d, e, f
    expect(node(graph, "/a").dominates).toBe(4); // c, d, e, f
    expect(node(graph, "/f").dominates).toBeUndefined();
    expect(node(graph, "/b").dominates).toBeUndefined();
  });

  it("is complete only when nothing was left unscanned", () => {
    expect(graph.complete).toBe(true);
    const partial = buildPageGraph(scanOf([page("/", [])], { partial: true }));
    expect(partial.complete).toBe(false);
    const limited = buildPageGraph(
      scanOf([page("/", [])], { skipped: [{ url: `${O}/x`, reason: "limit" }] }),
    );
    expect(limited.complete).toBe(false);
  });

  it("merges the links of both viewports and counts each link once", () => {
    const g = buildPageGraph(
      scanOf([
        page("/", ["/a"], "desktop"),
        page("/", ["/a", "/menu"], "mobile"),
        page("/a", []),
        page("/menu", []),
      ]),
    );
    expect(node(g, "/")).toMatchObject({ outbound: 2 });
    expect(node(g, "/menu")).toMatchObject({ inbound: 1, depth: 1 });
  });

  it("follows redirects found by the link check", () => {
    const g = buildPageGraph(
      scanOf([page("/", ["/old"]), page("/new", [])], {
        checks: {
          [`${O}/old`]: {
            url: `${O}/old`,
            finalUrl: `${O}/new`,
            status: 200,
            chain: [],
            loop: false,
            tooManyHops: false,
          },
        },
      }),
    );
    expect(node(g, "/new")).toMatchObject({ inbound: 1, depth: 1 });
    expect(g.nodes.some((n) => n.url === `${O}/old`)).toBe(false);
  });

  it("records the status of unscanned link targets (dead internal links)", () => {
    const g = buildPageGraph(
      scanOf([page("/", ["/gone"])], {
        checks: {
          [`${O}/gone`]: {
            url: `${O}/gone`,
            status: 404,
            chain: [],
            loop: false,
            tooManyHops: false,
          },
        },
      }),
    );
    expect(node(g, "/gone")).toMatchObject({ scanned: false, status: 404, inbound: 1 });
  });

  it("survives cycles and exposes inbound counts by address", () => {
    const g = buildPageGraph(scanOf([page("/", ["/a"]), page("/a", ["/", "/a"])]));
    expect(node(g, "/a")).toMatchObject({ inbound: 1, outbound: 1, depth: 1 });
    expect(inboundByUrl(g).get(`${O}/`)).toBe(1);
    expect(inboundByUrl(undefined).size).toBe(0);
  });
});
