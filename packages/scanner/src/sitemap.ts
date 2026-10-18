import { parseSitemapLocs } from "./robots";

export interface SitemapFetch {
  (url: string): Promise<{ status?: number; text?: string }>;
}

export interface SitemapLimits {
  /** Child sitemaps followed from a sitemap index (default 10). */
  maxSitemaps?: number;
  /** Page URLs collected in total (default 5000). */
  maxUrls?: number;
}

/**
 * Page URLs listed in a sitemap. A sitemap index (`<sitemapindex>`) is expanded one level into its
 * child sitemaps. Failures of child sitemaps are skipped: a broken child must not hide the others.
 */
export async function expandSitemap(
  rootText: string | undefined,
  fetchChild: SitemapFetch,
  limits: SitemapLimits = {},
): Promise<string[]> {
  const maxSitemaps = limits.maxSitemaps ?? 10;
  const maxUrls = limits.maxUrls ?? 5000;
  if (!rootText) return [];

  if (!/<sitemapindex[\s>]/i.test(rootText)) {
    return parseSitemapLocs(rootText).slice(0, maxUrls);
  }

  const urls: string[] = [];
  for (const child of parseSitemapLocs(rootText).slice(0, maxSitemaps)) {
    if (urls.length >= maxUrls) break;
    // gzip sitemaps are not decoded here; skip them rather than parse binary data
    if (/\.gz(\?|$)/i.test(child)) continue;
    const res = await fetchChild(child).catch(() => ({ status: undefined, text: undefined }));
    urls.push(...parseSitemapLocs(res.text));
  }
  return urls.slice(0, maxUrls);
}

const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

/** `/en/news/latest` -> locale `en`, shape `/news/*`. Pages of one template share a shape. */
export function urlShape(url: string): { locale: string; shape: string } {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return { locale: "", shape: "/" };
  }
  const locale = segments[0] && LOCALE.test(segments[0]) ? segments[0].toLowerCase() : "";
  const rest = locale ? segments.slice(1) : segments;
  if (rest.length === 0) return { locale, shape: "/" };
  if (rest.length === 1) return { locale, shape: `/${rest[0]}` };
  return { locale, shape: `/${rest[0]}/${"*/".repeat(rest.length - 1)}`.replace(/\/$/, "") };
}

/**
 * Picks `limit` URLs that represent the whole list instead of its first `limit` entries. Problems
 * cluster by page template and language, so the sample takes pages round-robin across templates
 * (shapes), and within a template across languages. Order inside each bucket is preserved.
 */
export function diverseSample(urls: string[], limit: number): string[] {
  if (limit <= 0) return [];
  if (urls.length <= limit) return [...urls];

  // shape -> locale -> urls
  const shapes = new Map<string, Map<string, string[]>>();
  for (const url of urls) {
    const { locale, shape } = urlShape(url);
    const byLocale = shapes.get(shape) ?? new Map<string, string[]>();
    byLocale.set(locale, [...(byLocale.get(locale) ?? []), url]);
    shapes.set(shape, byLocale);
  }

  // within a shape: interleave the locales (en, cs, de, en, cs, de, ...)
  const lists = [...shapes.values()].map((byLocale) => {
    const queues = [...byLocale.values()];
    const merged: string[] = [];
    for (let i = 0; queues.some((q) => i < q.length); i++) {
      for (const q of queues) if (i < q.length) merged.push(q[i]!);
    }
    return merged;
  });

  // across shapes: round-robin
  const picked: string[] = [];
  for (let round = 0; picked.length < limit && lists.some((l) => round < l.length); round++) {
    for (const list of lists) {
      if (round < list.length && picked.length < limit) picked.push(list[round]!);
    }
  }
  return picked;
}
