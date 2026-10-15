export interface RobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

/** Minimal robots.txt parser: the `*` group only, prefix rules, longest match wins. */
export function parseRobots(text: string | undefined): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  if (!text) return rules;

  let inStarGroup = false;
  let sawDirectiveInGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "sitemap") {
      if (value) rules.sitemaps.push(value);
    } else if (key === "user-agent") {
      if (sawDirectiveInGroup) {
        inStarGroup = false;
        sawDirectiveInGroup = false;
      }
      if (value === "*") inStarGroup = true;
    } else if (key === "disallow" || key === "allow") {
      sawDirectiveInGroup = true;
      if (inStarGroup && value) (key === "disallow" ? rules.disallow : rules.allow).push(value);
    }
  }
  return rules;
}

export function isAllowedByRobots(rules: RobotsRules, pathAndQuery: string): boolean {
  const longest = (list: string[]) =>
    list.filter((p) => pathAndQuery.startsWith(p)).reduce((m, p) => Math.max(m, p.length), -1);
  const disallowed = longest(rules.disallow);
  if (disallowed < 0) return true;
  return longest(rules.allow) >= disallowed;
}

/** Extracts `<loc>` values from a sitemap or sitemap index. */
export function parseSitemapLocs(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, "&"),
  );
}
