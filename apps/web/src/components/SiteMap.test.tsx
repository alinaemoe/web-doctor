import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Issue, Report } from "@webdoctor/core/shared";
import { buildMapModel } from "../lib/siteMap";
import { parseHash, mapHash } from "../lib/route";
import { SiteMap } from "./SiteMap";

const O = "https://site.test";
const node = (path: string, over: Record<string, unknown> = {}) => ({
  url: `${O}${path}`,
  inbound: 1,
  outbound: 1,
  inSitemap: false,
  scanned: true,
  ...over,
});

const issue = (pageUrl: string, severity: Issue["severity"], id = pageUrl + severity): Issue =>
  ({
    id,
    pageUrl,
    severity,
    verdict: "fail",
    status: "new",
    ruleId: "x",
    title: "t",
  }) as unknown as Issue;

function report(over: Partial<Report> = {}, nodes = defaultNodes): Report {
  return {
    schemaVersion: 1,
    run: { id: "run-1" },
    pages: [],
    groups: [],
    issues: [issue(`${O}/shop`, "high"), issue(`${O}/shop`, "low"), issue(`${O}/hidden`, "medium")],
    graph: {
      home: 0,
      complete: true,
      nodes,
      edges: [
        [0, 1],
        [0, 2],
        [1, 3],
      ],
    },
    ...over,
  } as unknown as Report;
}

const defaultNodes = [
  node("/", { depth: 0, inbound: 0, outbound: 2 }),
  node("/shop", { depth: 1, outbound: 1, dominates: 3 }),
  node("/about", { depth: 1, outbound: 0 }),
  node("/shop/a", { depth: 2, outbound: 0 }),
  node("/hidden", { inbound: 0, outbound: 0, inSitemap: true }),
];

describe("buildMapModel", () => {
  it("lays pages out by clicks from home, with unreachable pages last", () => {
    const model = buildMapModel(report())!;
    expect(model.mode).toBe("pages");
    expect(model.columns.map((c) => c.depth)).toEqual([0, 1, 2, "unreachable"]);
    expect(model.columns[3]!.items.map((i) => i.label)).toEqual(["/hidden"]);
  });

  it("colours a box by its worst problem and counts them", () => {
    const shop = buildMapModel(report())!.columns[1]!.items.find((i) => i.label === "/shop")!;
    expect(shop).toMatchObject({ failing: 2, worst: "high" });
  });

  it("ignores fixed and unverified problems", () => {
    const fixed = { ...issue(`${O}/shop`, "critical"), status: "fixed" } as Issue;
    const unsure = { ...issue(`${O}/shop`, "critical"), verdict: "unverified" } as Issue;
    const model = buildMapModel(report({ issues: [fixed, unsure] }))!;
    expect(model.columns[1]!.items.every((i) => i.failing === 0)).toBe(true);
  });

  it("summarizes the structure and ranks bottlenecks", () => {
    const { stats, bottlenecks, mostLinked } = buildMapModel(report())!;
    expect(stats).toMatchObject({ scanned: 5, unreachable: 1, deadEnds: 3, complete: true });
    expect(bottlenecks.map((n) => n.url)).toEqual([`${O}/shop`]);
    expect(mostLinked.length).toBeGreaterThan(0);
  });

  it("groups big sites into sections placed at the depth of their nearest page", () => {
    const many = [
      node("/", { depth: 0 }),
      ...Array.from({ length: 200 }, (_, i) => node(`/blog/p${i}`, { depth: 2 + (i % 3) })),
      ...Array.from({ length: 10 }, (_, i) => node(`/docs/d${i}`, { depth: 1 })),
    ];
    const model = buildMapModel(report({ issues: [] }, many))!;
    expect(model.mode).toBe("sections");
    const blog = model.columns.flatMap((c) => c.items).find((i) => i.id === "/blog")!;
    expect(blog).toMatchObject({ pages: 200, depth: 2 });
    expect(model.columns.flatMap((c) => c.items)).toHaveLength(3);
  });

  it("returns nothing for a run without a graph", () => {
    expect(buildMapModel(report({ graph: undefined }))).toBeUndefined();
  });
});

describe("SiteMap", () => {
  it("shows columns, the summary, and a selected page's neighbours", async () => {
    const user = userEvent.setup();
    render(<SiteMap report={report()} />);
    expect(screen.getByRole("heading", { name: "Site map" })).toBeInTheDocument();
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getByText(/not reachable by clicks/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^\/shop.*2 problems/ }));
    const detail = screen.getByRole("region", { name: "Selected" });
    expect(detail).toHaveTextContent("3 other pages are reachable only through it");
    expect(within(detail).getByText("/shop/a")).toBeInTheDocument(); // links to
    expect(within(detail).getByText("/")).toBeInTheDocument(); // linked from
  });

  it("warns that findings are tentative when the scan was not complete", () => {
    const partial = report();
    partial.graph!.complete = false;
    render(<SiteMap report={partial} />);
    expect(screen.getByRole("note")).toHaveTextContent("tentative");
  });

  it("explains when an older run has no link data", () => {
    render(<SiteMap report={report({ graph: undefined })} />);
    expect(screen.getByText(/no link data/)).toBeInTheDocument();
  });
});

describe("route", () => {
  it("round-trips the map address", () => {
    expect(parseHash(mapHash("run-9"))).toEqual({ name: "map", id: "run-9" });
    expect(parseHash("#/runs/run-9")).toMatchObject({ name: "run", id: "run-9" });
  });
});
