import type { GraphNode, Issue, PageGraph, Report, Severity } from "@webdoctor/core/shared";
import { DEEP_CLICKS } from "@webdoctor/core/shared";
import { SEVERITY_ORDER } from "./model";

/** One box on the map: a page, or (on big sites) a whole section such as `/products`. */
export interface MapItem {
  id: string;
  label: string;
  /** Pages inside (1 in page mode). */
  pages: number;
  /** Clicks from the home page; undefined = no link path leads here. */
  depth?: number;
  /** Problems (verdict fail) on these pages. */
  failing: number;
  worst?: Severity;
  /** Page mode: the page address. */
  url?: string;
  /** Pages that link to this page (page mode) or to the pages of this section. */
  inbound: number;
  /** Other pages reachable only through this one (page mode). */
  dominates: number;
  nodes: number[];
}

export interface MapColumn {
  /** Clicks from home, or "unreachable". */
  depth: number | "unreachable";
  items: MapItem[];
}

export interface MapModel {
  mode: "pages" | "sections";
  columns: MapColumn[];
  stats: {
    nodes: number;
    scanned: number;
    maxDepth: number;
    unreachable: number;
    deadEnds: number;
    deep: number;
    complete: boolean;
  };
  /** Pages ranked for the side lists. */
  bottlenecks: GraphNode[];
  mostLinked: GraphNode[];
  deepest: GraphNode[];
}

/** Above this many pages the map groups pages into sections: boxes for each page are unreadable. */
export const PAGE_MODE_LIMIT = 150;
export const PAGE_MODE_HARD_LIMIT = 600;

export function sectionOf(url: string): string {
  try {
    const first = new URL(url).pathname.split("/").filter(Boolean)[0];
    return first ? `/${first}` : "/";
  } catch {
    return "/";
  }
}

export function pathLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

/** Failing issues per page address, using the address the page ended up at when it was redirected. */
function issuesByPage(report: Report): Map<string, Issue[]> {
  const finalOf = new Map(report.pages.map((p) => [p.url, p.finalUrl]));
  const map = new Map<string, Issue[]>();
  for (const issue of report.issues) {
    if (issue.verdict !== "fail" || issue.status === "fixed") continue;
    const key = finalOf.get(issue.pageUrl) ?? issue.pageUrl;
    map.set(key, [...(map.get(key) ?? []), issue]);
  }
  return map;
}

const worstOf = (issues: Issue[]): Severity | undefined =>
  SEVERITY_ORDER.find((s) => issues.some((i) => i.severity === s));

export function buildMapModel(
  report: Report,
  requested: "pages" | "sections" | "auto" = "auto",
): MapModel | undefined {
  const graph: PageGraph | undefined = report.graph;
  if (!graph || graph.nodes.length === 0) return undefined;

  const byPage = issuesByPage(report);
  const mode =
    requested === "auto"
      ? graph.nodes.length <= PAGE_MODE_LIMIT
        ? "pages"
        : "sections"
      : requested === "pages" && graph.nodes.length > PAGE_MODE_HARD_LIMIT
        ? "sections"
        : requested;

  const items = new Map<string, MapItem>();
  graph.nodes.forEach((node, index) => {
    const id = mode === "pages" ? node.url : sectionOf(node.url);
    const issues = byPage.get(node.url) ?? [];
    const existing = items.get(id);
    if (!existing) {
      items.set(id, {
        id,
        label: mode === "pages" ? pathLabel(node.url) : id === "/" ? "/ (home)" : `${id}/…`,
        pages: 1,
        depth: node.depth,
        failing: issues.length,
        worst: worstOf(issues),
        url: mode === "pages" ? node.url : undefined,
        inbound: node.inbound,
        dominates: node.dominates ?? 0,
        nodes: [index],
      });
      return;
    }
    existing.pages++;
    existing.failing += issues.length;
    existing.worst = worstOf([
      ...(existing.worst ? [{ severity: existing.worst } as Issue] : []),
      ...issues,
    ]);
    existing.inbound += node.inbound;
    existing.nodes.push(index);
    // a section sits at the depth of its nearest page
    if (node.depth !== undefined && (existing.depth === undefined || node.depth < existing.depth)) {
      existing.depth = node.depth;
    }
  });

  const columns = new Map<number | "unreachable", MapItem[]>();
  for (const item of items.values()) {
    const key = item.depth ?? "unreachable";
    columns.set(key, [...(columns.get(key) ?? []), item]);
  }
  const ordered: MapColumn[] = [...columns.entries()]
    .sort(([a], [b]) => (a === "unreachable" ? 1 : b === "unreachable" ? -1 : a - b))
    .map(([depth, list]) => ({
      depth,
      items: list.sort(
        (a, b) => b.failing - a.failing || b.pages - a.pages || a.label.localeCompare(b.label),
      ),
    }));

  const scannedNodes = graph.nodes.filter((n) => n.scanned);
  const reachable = graph.nodes.filter((n) => n.depth !== undefined);
  const rank = (list: GraphNode[], by: (n: GraphNode) => number, n = 5) =>
    [...list]
      .sort((a, b) => by(b) - by(a))
      .filter((x) => by(x) > 0)
      .slice(0, n);

  return {
    mode,
    columns: ordered,
    stats: {
      nodes: graph.nodes.length,
      scanned: scannedNodes.length,
      maxDepth: reachable.reduce((m, n) => Math.max(m, n.depth!), 0),
      unreachable: scannedNodes.filter(
        (n, _i) => n.depth === undefined && graph.nodes[graph.home] !== n,
      ).length,
      deadEnds: scannedNodes.length > 1 ? scannedNodes.filter((n) => n.outbound === 0).length : 0,
      deep: scannedNodes.filter((n) => (n.depth ?? 0) >= DEEP_CLICKS).length,
      complete: graph.complete,
    },
    bottlenecks: rank(graph.nodes, (n) => n.dominates ?? 0).filter((n) => (n.dominates ?? 0) >= 3),
    mostLinked: rank(graph.nodes, (n) => n.inbound),
    deepest: rank(scannedNodes, (n) => n.depth ?? 0).filter((n) => (n.depth ?? 0) >= DEEP_CLICKS),
  };
}
