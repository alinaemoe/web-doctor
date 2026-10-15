import { chromium } from "playwright";
import { isSameOrigin, normalizeUrl } from "@webdoctor/core";
import type {
  LinkCheck,
  PageSnapshot,
  ScanResult,
  ScanViewport,
  SkippedUrl,
} from "@webdoctor/core";
import type { ArtifactStore } from "./artifacts";
import { collectPage } from "./collect";
import { checkLink, checkLinks, fetchText } from "./linkCheck";
import { isAllowedByRobots, parseRobots, parseSitemapLocs } from "./robots";

export const SCANNER_VERSION = "0.0.0";

export type ScanProgress =
  | { type: "page"; url: string; viewport: ScanViewport; done: number; queued: number }
  | { type: "skipped"; url: string; reason: SkippedUrl["reason"] }
  | { type: "links"; total: number };

export interface ScanOptions {
  startUrl: string;
  artifacts: ArtifactStore;
  maxPages?: number;
  maxDepth?: number;
  viewports?: ScanViewport[];
  concurrency?: number;
  respectRobots?: boolean;
  /** Total time budget in ms; the scan stops gracefully and is marked partial. */
  timeoutMs?: number;
  pageTimeoutMs?: number;
  /** Cap on distinct external URLs that get checked. */
  maxExternalLinks?: number;
  signal?: AbortSignal;
  userAgent?: string;
  onProgress?: (event: ScanProgress) => void;
}

const ASSET_EXT =
  /\.(pdf|zip|gz|tar|png|jpe?g|gif|webp|avif|svg|ico|css|m?js|json|xml|txt|mp4|webm|mp3|woff2?|ttf|eot)$/i;

interface QueueItem {
  url: string;
  depth: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Crawls same-origin pages breadth-first (bounded by pages/depth/time), collects artifacts per
 * page and viewport, then checks every link target once. Never throws for site problems: those
 * become data (skipped URLs, failed link checks, partial flag).
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const start = normalizeUrl(options.startUrl);
  if (!start) throw new Error(`Invalid start URL: ${options.startUrl}`);
  const origin = new URL(start).origin;

  const maxPages = options.maxPages ?? 50;
  const maxDepth = options.maxDepth ?? 3;
  const viewports = options.viewports?.length
    ? options.viewports
    : (["desktop", "mobile"] as const);
  const concurrency = options.concurrency ?? 3;
  const respectRobots = options.respectRobots ?? true;
  const pageTimeoutMs = options.pageTimeoutMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  const checkOpts = { userAgent: options.userAgent };

  const stopReasonOf = (): ScanResult["stopReason"] | undefined => {
    if (options.signal?.aborted) return "canceled";
    if (Date.now() > deadline) return "timeout";
    return undefined;
  };

  const robots = await fetchText(`${origin}/robots.txt`, checkOpts);
  const robotsRules = parseRobots(robots.text);
  const sitemapUrl = robotsRules.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemapRes = await fetchText(sitemapUrl, checkOpts);

  const linkChecks = new Map<string, LinkCheck>();
  const pages: PageSnapshot[] = [];
  const skipped: SkippedUrl[] = [];
  const queue: QueueItem[] = [{ url: start, depth: 0 }];
  const claimed = new Set<string>([start]);
  let visitedCount = 0;
  let droppedByLimit = false;
  let active = 0;

  const skip = (url: string, reason: SkippedUrl["reason"], detail?: string) => {
    skipped.push({ url, reason, detail });
    options.onProgress?.({ type: "skipped", url, reason });
  };

  const browser = await chromium.launch();
  try {
    const processItem = async (item: QueueItem) => {
      const path = (() => {
        const u = new URL(item.url);
        return u.pathname + u.search;
      })();
      if (respectRobots && !isAllowedByRobots(robotsRules, path)) {
        return skip(item.url, "robots");
      }

      // Cheap pre-check: skips dead links, loops and redirects to pages we already have.
      let check = linkChecks.get(item.url);
      if (!check) {
        check = await checkLink(item.url, checkOpts);
        linkChecks.set(item.url, check);
      }
      if (check.error || check.loop || check.tooManyHops || (check.status ?? 0) >= 400) {
        return skip(item.url, "http-error", check.error ?? String(check.status ?? "redirect"));
      }
      const target = normalizeUrl(check.finalUrl ?? item.url) ?? item.url;
      if (target !== item.url) {
        if (!isSameOrigin(target, origin)) return skip(item.url, "external", target);
        if (claimed.has(target)) return skip(item.url, "http-error", "redirects to a known page");
        claimed.add(target);
      }

      let first: PageSnapshot | undefined;
      for (const viewport of viewports) {
        if (stopReasonOf()) break;
        const result = await collectPage(browser, target, {
          viewport,
          depth: item.depth,
          artifacts: options.artifacts,
          pageTimeoutMs,
          userAgent: options.userAgent,
        });
        if (!result.ok) {
          if (!first) skip(target, result.reason, result.detail);
          break;
        }
        first ??= result.snapshot;
        pages.push(result.snapshot);
        options.onProgress?.({
          type: "page",
          url: target,
          viewport,
          done: ++visitedCount,
          queued: queue.length,
        });
      }

      if (!first || item.depth >= maxDepth) return;
      for (const link of first.links) {
        const next = normalizeUrl(link.href);
        if (!next || claimed.has(next) || !isSameOrigin(next, origin)) continue;
        if (ASSET_EXT.test(new URL(next).pathname)) continue;
        if (claimed.size >= maxPages) {
          droppedByLimit = true;
          continue;
        }
        claimed.add(next);
        queue.push({ url: next, depth: item.depth + 1 });
      }
    };

    const worker = async () => {
      for (;;) {
        if (stopReasonOf()) return;
        const item = queue.shift();
        if (!item) {
          if (active === 0) return;
          await sleep(25);
          continue;
        }
        active++;
        try {
          await processItem(item);
        } finally {
          active--;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await browser.close().catch(() => undefined);
  }

  const stopReason = stopReasonOf();

  // ---- check every link target once (internal + capped external) ----
  const internalTargets = new Set<string>();
  const externalTargets = new Set<string>();
  const addTarget = (raw: string, base?: string) => {
    const url = normalizeUrl(raw, base);
    if (!url) return;
    (isSameOrigin(url, origin) ? internalTargets : externalTargets).add(url);
  };
  for (const page of pages) {
    for (const link of page.links) addTarget(link.href);
    if (page.canonical) addTarget(page.canonical, page.finalUrl);
  }
  const sitemapLocs = parseSitemapLocs(sitemapRes.text);
  for (const loc of sitemapLocs.slice(0, 500)) addTarget(loc);

  const external = [...externalTargets].slice(0, options.maxExternalLinks ?? 200);
  const allTargets = [...internalTargets, ...external];
  options.onProgress?.({ type: "links", total: allTargets.length });
  await checkLinks(allTargets, linkChecks, { ...checkOpts, signal: options.signal });

  const droppedPartial = droppedByLimit && !stopReason;
  return {
    scannerVersion: SCANNER_VERSION,
    startUrl: start,
    origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    partial: Boolean(stopReason) || droppedPartial,
    stopReason: stopReason ?? (droppedPartial ? "max-pages" : undefined),
    pages,
    skipped,
    linkChecks: Object.fromEntries(linkChecks),
    robots: { url: robots.url, status: robots.status, text: robots.text, error: robots.error },
    sitemap: {
      url: sitemapUrl,
      status: sitemapRes.status,
      text: undefined,
      error: sitemapRes.error,
      locs: sitemapLocs,
      declaredInRobots: robotsRules.sitemaps.length > 0,
    },
  };
}
