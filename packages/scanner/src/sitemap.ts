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
