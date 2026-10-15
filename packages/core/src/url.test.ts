import { describe, expect, it } from "vitest";
import { isSameOrigin, normalizeUrl, pageKey, pathTemplate } from "./url";

describe("normalizeUrl", () => {
  it("drops fragment, credentials and tracking params and sorts the query", () => {
    expect(normalizeUrl("https://User:pw@Example.com:443/a/?b=2&utm_source=x&a=1#top")).toBe(
      "https://example.com/a?a=1&b=2",
    );
  });

  it("keeps the root slash and removes trailing slashes elsewhere", () => {
    expect(normalizeUrl("http://localhost:4000")).toBe("http://localhost:4000/");
    expect(normalizeUrl("http://localhost:4000/x///")).toBe("http://localhost:4000/x");
  });

  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("../b", "https://example.com/a/c")).toBe("https://example.com/b");
  });

  it("rejects non-http(s) and invalid input", () => {
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("isSameOrigin", () => {
  it("compares scheme, host and port", () => {
    expect(isSameOrigin("http://localhost:4000/a", "http://localhost:4000/b")).toBe(true);
    expect(isSameOrigin("http://localhost:4000/a", "http://localhost:4001/a")).toBe(false);
  });
});

describe("pageKey / pathTemplate", () => {
  it("ignores origin", () => {
    expect(pageKey("https://staging.example.com/p?b=1&a=2")).toBe("/p?a=2&b=1");
  });

  it("replaces ids, uuids and long hashes with :id", () => {
    expect(pathTemplate("https://e.com/orders/123/items/9f1c2b3d4e5f6a7b8c9d")).toBe(
      "/orders/:id/items/:id",
    );
    expect(pathTemplate("https://e.com/u/123e4567-e89b-12d3-a456-426614174000")).toBe("/u/:id");
    expect(pathTemplate("https://e.com/category/cat-01")).toBe("/category/cat-01");
  });
});
