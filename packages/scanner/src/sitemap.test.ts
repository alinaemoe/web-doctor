import { describe, expect, it, vi } from "vitest";
import { expandSitemap } from "./sitemap";

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
