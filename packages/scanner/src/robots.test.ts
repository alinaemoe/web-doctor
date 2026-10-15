import { describe, expect, it } from "vitest";
import { isAllowedByRobots, parseRobots, parseSitemapLocs } from "./robots";

describe("parseRobots / isAllowedByRobots", () => {
  const rules = parseRobots(`
# comment
User-agent: Googlebot
Disallow: /google-only

User-agent: *
Disallow: /private
Allow: /private/public
Sitemap: https://example.com/sitemap.xml
`);

  it("reads only the * group and the sitemap lines", () => {
    expect(rules.disallow).toEqual(["/private"]);
    expect(rules.allow).toEqual(["/private/public"]);
    expect(rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("applies the longest matching rule", () => {
    expect(isAllowedByRobots(rules, "/")).toBe(true);
    expect(isAllowedByRobots(rules, "/private/x")).toBe(false);
    expect(isAllowedByRobots(rules, "/private/public/x")).toBe(true);
    expect(isAllowedByRobots(rules, "/google-only")).toBe(true);
  });

  it("allows everything when robots.txt is missing", () => {
    expect(isAllowedByRobots(parseRobots(undefined), "/anything")).toBe(true);
  });
});

describe("parseSitemapLocs", () => {
  it("extracts and unescapes <loc> values", () => {
    expect(
      parseSitemapLocs(
        "<urlset><url><loc> https://a.com/x?a=1&amp;b=2 </loc></url><url><loc>https://a.com/y</loc></url></urlset>",
      ),
    ).toEqual(["https://a.com/x?a=1&b=2", "https://a.com/y"]);
    expect(parseSitemapLocs(undefined)).toEqual([]);
  });
});
