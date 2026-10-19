import { DEEP_CLICKS } from "@webdoctor/core";
import type { Evidence, GraphNode, PageGraph, PageSnapshot } from "@webdoctor/core";
import { makeDraft, pagePathOf } from "./draft";
import type { IssueDraft } from "./draft";

const metric = (name: string, value: number, threshold: number, unit: string): Evidence => ({
  type: "metric",
  name,
  value,
  threshold,
  unit,
});

/**
 * Rules about how pages are connected. They need the whole picture of the site, so they run once
 * after the crawl. "Nobody links here" and "N clicks away" are facts only when every page was
 * scanned; otherwise an unscanned page might link here or shorten the path, and the finding is
 * reported as "could not be sure" (unverified) instead of as a failure.
 */
export function graphRules(graph: PageGraph, pages: PageSnapshot[]): IssueDraft[] {
  const scanned = new Map<string, PageSnapshot>();
  for (const p of pages) scanned.set(p.finalUrl, p);
  for (const p of pages) if (!scanned.has(p.url)) scanned.set(p.url, p);

  const drafts: IssueDraft[] = [];
  graph.nodes.forEach((node, index) => {
    if (!node.scanned || (node.status ?? 200) >= 400) return;
    const snapshot = scanned.get(node.url);
    if (!snapshot) return;
    const page = { url: snapshot.url, viewport: "all" as const };
    const isHome = index === graph.home;
    const sure = graph.complete
      ? { verdict: "fail" as const }
      : {
          verdict: "unverified" as const,
          unverifiedReason: "needs_manual_review" as const,
          confidence: 0.4,
        };

    if (!isHome && node.depth === undefined) {
      drafts.push(orphan(node, page, sure));
    } else if (node.depth !== undefined && node.depth >= DEEP_CLICKS) {
      drafts.push(deep(node, page, sure));
    }
    // on a one-page site there is nothing to link to
    if (node.outbound === 0 && scanned.size > 1) {
      drafts.push(
        makeDraft({
          ruleId: "nav.page.dead-end",
          page,
          evidence: [metric("outbound-links", 0, 1, "links")],
          what: `${pagePathOf(node.url)} has no links to other pages of the site.`,
          where: `Page ${pagePathOf(node.url)}`,
          confidence: 0.6,
        }),
      );
    }
  });
  return drafts;
}

type Sure =
  | { verdict: "fail" }
  | { verdict: "unverified"; unverifiedReason: "needs_manual_review"; confidence: number };

function orphan(node: GraphNode, page: { url: string; viewport: "all" }, sure: Sure): IssueDraft {
  const where = node.inSitemap ? "listed in the sitemap" : "found by the scan";
  const incomplete = sure.verdict === "unverified";
  return makeDraft({
    ruleId: "nav.page.orphan",
    page,
    evidence: [metric("inbound-links", node.inbound, 1, "links")],
    what: `No link path from the home page leads to ${pagePathOf(node.url)} (${where}${
      node.inbound > 0
        ? `; ${node.inbound} page(s) link to it, but they are cut off from the home page too`
        : ""
    }).${incomplete ? " Not every page of the site was scanned, so a page that was not scanned may still link here." : ""}`,
    where: `Page ${pagePathOf(node.url)}`,
    confidence: 0.9,
    ...sure,
  });
}

function deep(node: GraphNode, page: { url: string; viewport: "all" }, sure: Sure): IssueDraft {
  const clicks = node.depth!;
  return makeDraft({
    ruleId: "nav.page.deep",
    page,
    evidence: [metric("click-depth", clicks, DEEP_CLICKS - 1, "clicks")],
    what: `${pagePathOf(node.url)} is ${clicks} clicks away from the home page.${
      sure.verdict === "unverified"
        ? " Not every page of the site was scanned, so a shorter path may exist."
        : ""
    }`,
    where: `Page ${pagePathOf(node.url)}`,
    confidence: 0.9,
    ...sure,
  });
}
