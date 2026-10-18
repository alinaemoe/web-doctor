import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectedManifest } from "./expected";
import { categoryPaths, crawlablePaths } from "./pages";
import { startDemoSite } from "./server";
import type { DemoSite } from "./server";

let site: DemoSite;
const get = (path: string, init?: RequestInit) =>
  fetch(site.url + path, { redirect: "manual", ...init });
const text = async (path: string) => (await get(path)).text();

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
});
afterAll(async () => {
  await site.close();
});

describe("Broken Shop — broken mode", () => {
  it("serves every crawlable page with 200", async () => {
    site.setMode("broken");
    for (const path of crawlablePaths) {
      expect((await get(path)).status, path).toBe(200);
    }
  });

  it("renders the category template without <h1> on all 18 categories", async () => {
    site.setMode("broken");
    expect(categoryPaths).toHaveLength(18);
    for (const path of categoryPaths) {
      expect(await text(path), path).not.toMatch(/<h1[ >]/);
    }
  });

  it("has the footer 404, missing font and missing product image", async () => {
    site.setMode("broken");
    expect(await text("/")).toContain('href="/missing-page"');
    expect((await get("/missing-page")).status).toBe(404);
    expect(await text("/assets/site.css")).toContain("/fonts/missing.woff2");
    expect((await get("/fonts/missing.woff2")).status).toBe(404);
    expect((await get("/img/backpack-missing.jpg")).status).toBe(404);
    expect(await text("/products/backpack")).toMatch(/<h1>Backpack<\/h1>[\s\S]*<h1>Reviews<\/h1>/);
  });

  it("serves a 3-hop redirect chain and a redirect loop", async () => {
    const hops: string[] = [];
    let path = "/old";
    for (let i = 0; i < 5; i++) {
      const res = await get(path);
      if (res.status !== 301) break;
      path = res.headers.get("location")!;
      hops.push(path);
    }
    expect(hops).toEqual(["/old-2", "/old-3", "/new-arrivals"]);
    expect((await get("/loop-a")).headers.get("location")).toBe("/loop-b");
    expect((await get("/loop-b")).headers.get("location")).toBe("/loop-a");
  });

  it("lists a 404 URL in the sitemap and a broken canonical on /about", async () => {
    expect(await text("/sitemap.xml")).toContain("/gone</loc>");
    expect((await get("/gone")).status).toBe(404);
    const about = await text("/about");
    expect(about).toContain('rel="canonical" href="' + site.url + '/gone"');
    expect(about).not.toContain('name="description"');
  });

  it("serves a heavy script and an external origin that answers 429", async () => {
    expect((await text("/assets/storefront.js")).length).toBeGreaterThan(400_000);
    const ext = await fetch(site.extUrl + "/limited");
    expect(ext.status).toBe(429);
    expect(new URL(site.extUrl).origin).not.toBe(new URL(site.url).origin);
  });
});

describe("Broken Shop — fixed mode and controls", () => {
  it("switches to fixed at runtime via the control endpoint", async () => {
    const res = await get("/__demo/mode/fixed", { method: "POST" });
    expect(await res.json()).toEqual({ mode: "fixed", flakyDown: false, down: [] });
    expect(site.getMode()).toBe("fixed");
  });

  it("fixes the defects", async () => {
    site.setMode("fixed");
    for (const path of categoryPaths) expect(await text(path), path).toMatch(/<h1>/);
    expect(await text("/")).not.toContain("/missing-page");
    expect(await text("/assets/site.css")).not.toContain("missing.woff2");
    expect((await text("/assets/storefront.js")).length).toBeLessThan(1000);
    expect(await text("/sitemap.xml")).not.toContain("/gone");
    expect(await text("/products/backpack")).not.toMatch(/<h1>Reviews/);
    expect(await text("/about")).toContain('name="description"');
    expect(await text("/checkout")).toContain('<label for="email">');
  });

  it("answers 503 on /flaky while it is switched down, then recovers", async () => {
    await get("/__demo/flaky/down", { method: "POST" });
    expect((await get("/flaky")).status).toBe(503);
    await get("/__demo/flaky/up", { method: "POST" });
    expect((await get("/flaky")).status).toBe(200);
  });

  it("takes any single path down with 503 and back up", async () => {
    await get("/__demo/down/" + encodeURIComponent("/cart"), { method: "POST" });
    expect((await get("/cart")).status).toBe(503);
    expect((await get("/about")).status).toBe(200);
    site.setPathDown("/about", true);
    expect((await get("/about")).status).toBe(503);
    await get("/__demo/up/" + encodeURIComponent("/cart"), { method: "POST" });
    site.setPathDown("/about", false);
    expect((await get("/cart")).status).toBe(200);
    expect((await get("/about")).status).toBe(200);
  });

  it("rejects unknown controls and non-GET methods", async () => {
    expect((await get("/__demo/nope/x", { method: "POST" })).status).toBe(404);
    expect((await get("/", { method: "DELETE" })).status).toBe(405);
  });
});

describe("expected-issues.json", () => {
  it("is in sync with expected.ts (run `pnpm --filter @webdoctor/demo-site gen:expected`)", () => {
    const path = fileURLToPath(new URL("../expected-issues.json", import.meta.url));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expectedManifest);
  });

  it("only references pages that exist and rule ids with a known prefix", () => {
    const known = new Set([...crawlablePaths, "/sitemap.xml"]);
    for (const mode of ["broken", "fixed"] as const) {
      for (const issue of expectedManifest.modes[mode].issues) {
        expect(issue.ruleId).toMatch(/^(link|res|a11y|seo|runtime)\./);
        if (issue.pages !== "all-crawled") {
          for (const p of issue.pages) expect(known.has(p), p).toBe(true);
        }
      }
    }
  });

  it("keeps the fixed mode down to the single unverifiable external link", () => {
    expect(expectedManifest.modes.fixed.issues.map((i) => i.verdict)).toEqual(["unverified"]);
  });
});
