import type { ScanResult } from "./snapshot";
import type { GraphNode, PageGraph } from "./types";
import { isSameOrigin, normalizeUrl } from "./url";

const ASSET_EXT =
  /\.(pdf|zip|gz|tar|png|jpe?g|gif|webp|avif|svg|ico|css|m?js|json|xml|txt|mp4|webm|mp3|woff2?|ttf|eot)$/i;

/** Bounds that keep the stored graph small on huge sites. */
export const MAX_GRAPH_NODES = 10_000;
export const MAX_GRAPH_EDGES = 60_000;

/** Pages this many clicks (or more) from the home page are "deep". */
export const DEEP_CLICKS = 5;

type GraphInput = Pick<
  ScanResult,
  "pages" | "origin" | "startUrl" | "linkChecks" | "sitemap" | "partial" | "skipped"
>;

/**
 * The link structure of a scanned site: pages are nodes, "page A has a link to page B" are edges.
 * Links of all viewports are merged (a mobile menu may link to pages the desktop one does not).
 *
 *  - `depth` is the fewest clicks from the home page along the links that were seen.
 *  - `complete` says whether every page of the site was scanned. Only then are "nobody links here"
 *    and "this is N clicks away" facts; otherwise unscanned pages might link the page or shorten
 *    the path, and the rules say "could not be sure".
 *  - `dominates` counts pages that can be reached ONLY through this page (it is a bottleneck).
 */
export function buildPageGraph(scan: GraphInput): PageGraph {
  const nodes: GraphNode[] = [];
  const index = new Map<string, number>();
  const alias = new Map<string, string>(); // requested url -> key of the scanned page
  let capped = false;

  const ensure = (url: string): number | null => {
    const known = index.get(url);
    if (known !== undefined) return known;
    if (nodes.length >= MAX_GRAPH_NODES) {
      capped = true;
      return null;
    }
    nodes.push({ url, inbound: 0, outbound: 0, inSitemap: false, scanned: false });
    index.set(url, nodes.length - 1);
    return nodes.length - 1;
  };

  const sameSite = (url: string) => isSameOrigin(url, scan.origin);

  // pages that were actually loaded, keyed by where they ended up
  for (const page of scan.pages) {
    const requested = normalizeUrl(page.url);
    const final = normalizeUrl(page.finalUrl);
    const key = final && sameSite(final) ? final : requested;
    if (!key) continue;
    if (requested) alias.set(requested, key);
    const i = ensure(key);
    if (i === null) continue;
    nodes[i]!.scanned = true;
    nodes[i]!.status = page.status;
  }

  /** The node an address leads to: follows the redirect found by the link check. */
  const resolve = (href: string): string | null => {
    const url = normalizeUrl(href);
    if (!url || !sameSite(url) || ASSET_EXT.test(new URL(url).pathname)) return null;
    const finalUrl = scan.linkChecks[url]?.finalUrl;
    const moved = finalUrl ? normalizeUrl(finalUrl) : null;
    const target = moved && sameSite(moved) ? moved : url;
    return alias.get(target) ?? target;
  };

  const home = resolve(scan.startUrl) ?? normalizeUrl(scan.startUrl) ?? scan.startUrl;
  const homeIndex = ensure(home);

  // edges: the distinct internal targets of each scanned page
  const outgoing = new Map<number, Set<number>>();
  let edgeCount = 0;
  const seenLinks = new Set<string>();
  for (const page of scan.pages) {
    const requested = normalizeUrl(page.url);
    const from = requested ? index.get(alias.get(requested) ?? requested) : undefined;
    if (from === undefined) continue;
    const targets = outgoing.get(from) ?? new Set<number>();
    outgoing.set(from, targets);
    for (const link of page.links) {
      const key = `${from}|${link.href}`;
      if (seenLinks.has(key)) continue; // the same link seen in both viewports
      seenLinks.add(key);
      const target = resolve(link.href);
      if (!target) continue;
      const to = ensure(target);
      if (to === null || to === from || targets.has(to)) continue;
      if (edgeCount >= MAX_GRAPH_EDGES) {
        capped = true;
        continue;
      }
      targets.add(to);
      edgeCount++;
      const check = scan.linkChecks[normalizeUrl(link.href) ?? ""];
      if (!nodes[to]!.scanned && nodes[to]!.status === undefined && check?.status !== undefined) {
        nodes[to]!.status = check.status;
      }
    }
  }

  // pages the sitemap lists
  for (const loc of scan.sitemap.locs) {
    const target = resolve(loc);
    if (!target) continue;
    const i = ensure(target);
    if (i !== null) nodes[i]!.inSitemap = true;
  }

  const edges: [number, number][] = [];
  for (const [from, targets] of outgoing) {
    for (const to of targets) {
      edges.push([from, to]);
      nodes[from]!.outbound++;
      nodes[to]!.inbound++;
    }
  }

  const adjacency: number[][] = nodes.map(() => []);
  for (const [from, to] of edges) adjacency[from]!.push(to);

  if (homeIndex !== null) {
    markDepth(nodes, adjacency, homeIndex);
    markDominated(nodes, adjacency, homeIndex);
  }

  return {
    home: homeIndex ?? -1,
    nodes,
    edges,
    complete: !scan.partial && !capped && !scan.skipped.some((s) => s.reason === "limit"),
    capped: capped || undefined,
  };
}

/** Fewest clicks from `start`, by breadth-first search. */
function markDepth(nodes: GraphNode[], adjacency: number[][], start: number): void {
  nodes[start]!.depth = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const next of adjacency[current]!) {
      if (nodes[next]!.depth !== undefined) continue;
      nodes[next]!.depth = nodes[current]!.depth! + 1;
      queue.push(next);
    }
  }
}

/**
 * Dominators (Cooper, Harvey, Kennedy): page D dominates page P when every click path from the
 * home page to P goes through D. `dominates` = how many other pages D dominates.
 */
function markDominated(nodes: GraphNode[], adjacency: number[][], start: number): void {
  // reverse postorder of the reachable part, by an iterative depth-first search
  const order: number[] = [];
  const state = new Uint8Array(nodes.length); // 0 new, 1 open, 2 done
  const stack: [number, number][] = [[start, 0]];
  state[start] = 1;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = adjacency[frame[0]]![frame[1]++];
    if (next === undefined) {
      state[frame[0]] = 2;
      order.push(frame[0]);
      stack.pop();
    } else if (state[next] === 0) {
      state[next] = 1;
      stack.push([next, 0]);
    }
  }
  order.reverse();
  const position = new Int32Array(nodes.length).fill(-1);
  order.forEach((node, i) => (position[node] = i));

  const predecessors: number[][] = nodes.map(() => []);
  for (const node of order) for (const to of adjacency[node]!) predecessors[to]!.push(node);

  const idom = new Int32Array(nodes.length).fill(-1);
  idom[start] = start;
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (position[a]! > position[b]!) a = idom[a]!;
      while (position[b]! > position[a]!) b = idom[b]!;
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const node of order) {
      if (node === start) continue;
      let candidate = -1;
      for (const p of predecessors[node]!) {
        if (position[p]! < 0 || idom[p] === -1) continue;
        candidate = candidate === -1 ? p : intersect(p, candidate);
      }
      if (candidate !== -1 && idom[node] !== candidate) {
        idom[node] = candidate;
        changed = true;
      }
    }
  }

  // subtree sizes of the dominator tree: parents come before children in reverse postorder
  const size = new Int32Array(nodes.length).fill(1);
  for (let i = order.length - 1; i > 0; i--) {
    const node = order[i]!;
    size[idom[node]!]! += size[node]!;
  }
  for (const node of order) {
    if (node !== start && size[node]! > 1) nodes[node]!.dominates = size[node]! - 1;
  }
}

/** Inbound link counts keyed by page address (for ranking problems by how visible the page is). */
export function inboundByUrl(graph: PageGraph | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const node of graph?.nodes ?? []) map.set(node.url, node.inbound);
  return map;
}
