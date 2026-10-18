import { describe, expect, it, vi } from "vitest";
import { diverseSample, expandSitemap, urlShape } from "./sitemap";

const urlset = (...locs: string[]) =>
  `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
const index = (...locs: string[]) =>
  `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("expandSitemap", () => {
  it("returns the page URLs of a plain sitemap without fetching anything", async () => {
    const fetchChild = vi.fn();
    expect(await expandSitemap(urlset("http://s/a", "http://s/b"), fetchChild)).toEqual([
      "http://s/a",
      "http://s/b",
    ]);
    expect(fetchChild).not.toHaveBeenCalled();
  });

  it("expands a sitemap index into its child sitemaps", async () => {
    const children: Record<string, string> = {
      "http://s/sm-1.xml": urlset("http://s/a"),
      "http://s/sm-2.xml": urlset("http://s/b", "http://s/c"),
    };
    const urls = await expandSitemap(
      index("http://s/sm-1.xml", "http://s/sm-2.xml"),
      async (u) => ({
        status: 200,
        text: children[u],
      }),
    );
    expect(urls).toEqual(["http://s/a", "http://s/b", "http://s/c"]);
  });

  it("skips a broken or gzip child and still returns the others", async () => {
    const fetchChild = vi.fn(async (u: string) => {
      if (u.endsWith("bad.xml")) throw new Error("boom");
      return { status: 200, text: urlset("http://s/ok") };
    });
    const urls = await expandSitemap(
      index("http://s/bad.xml", "http://s/zipped.xml.gz", "http://s/good.xml"),
      fetchChild,
    );
    expect(urls).toEqual(["http://s/ok"]);
    expect(fetchChild).toHaveBeenCalledTimes(2); // the .gz child was not requested
  });

  it("respects the sitemap and URL limits", async () => {
    const fetchChild = vi.fn(async () => ({
      status: 200,
      text: urlset("http://s/1", "http://s/2", "http://s/3"),
    }));
    const limited = await expandSitemap(
      index("http://s/a.xml", "http://s/b.xml", "http://s/c.xml"),
      fetchChild,
      {
        maxSitemaps: 2,
        maxUrls: 4,
      },
    );
    expect(fetchChild).toHaveBeenCalledTimes(2);
    expect(limited).toHaveLength(4);
  });

  it("copes with missing input", async () => {
    expect(await expandSitemap(undefined, async () => ({}))).toEqual([]);
    expect(await expandSitemap("not xml at all", async () => ({}))).toEqual([]);
  });
});

describe("urlShape", () => {
  it("separates the language from the page template", () => {
    expect(urlShape("https://s.test/en")).toEqual({ locale: "en", shape: "/" });
    expect(urlShape("https://s.test/en/faq")).toEqual({ locale: "en", shape: "/faq" });
    expect(urlShape("https://s.test/cs/news/latest-news")).toEqual({
      locale: "cs",
      shape: "/news/*",
    });
    expect(urlShape("https://s.test/pt-br/a/b/c")).toEqual({ locale: "pt-br", shape: "/a/*/*" });
    expect(urlShape("https://s.test/products/123")).toEqual({ locale: "", shape: "/products/*" });
    expect(urlShape("not a url")).toEqual({ locale: "", shape: "/" });
  });
});

describe("diverseSample", () => {
  const langs = ["en", "cs", "de", "fr"];
  // 4 languages x (1 home + 3 pages + 30 attractions)
  const urls = langs.flatMap((l) => [
    `https://s.test/${l}`,
    ...["faq", "news", "contact"].map((p) => `https://s.test/${l}/${p}`),
    ...Array.from({ length: 30 }, (_, i) => `https://s.test/${l}/attractions/item-${i}`),
  ]);

  it("returns everything when it already fits", () => {
    expect(diverseSample(urls.slice(0, 5), 10)).toEqual(urls.slice(0, 5));
    expect(diverseSample(urls, 0)).toEqual([]);
  });

  it("does not just take the first entries: every template shows up", () => {
    const sample = diverseSample(urls, 12);
    expect(sample).toHaveLength(12);
    expect(new Set(sample).size).toBe(12);
    const shapes = new Set(sample.map((u) => urlShape(u).shape));
    expect(shapes).toEqual(new Set(["/", "/faq", "/news", "/contact", "/attractions/*"]));
    // the naive "first 12" would be only the English pages
    expect(new Set(urls.slice(0, 12).map((u) => urlShape(u).locale)).size).toBe(1);
  });

  it("spreads each template across languages", () => {
    const attractions = diverseSample(urls, 40).filter(
      (u) => urlShape(u).shape === "/attractions/*",
    );
    expect(new Set(attractions.map((u) => urlShape(u).locale)).size).toBe(4);
  });

  it("is deterministic and keeps sitemap order inside a bucket", () => {
    expect(diverseSample(urls, 20)).toEqual(diverseSample(urls, 20));
    const en = diverseSample(urls, 30).filter((u) => u.includes("/en/attractions/"));
    const indexes = en.map((u) => Number(u.split("item-")[1]));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
