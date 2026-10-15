import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { checkLink, checkLinks } from "./linkCheck";
import type { LinkCheck } from "@webdoctor/core";

let site: DemoSite;
beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
});
afterAll(async () => {
  await site.close();
});

describe("checkLink", () => {
  it("reports a plain 200 without a chain", async () => {
    const r = await checkLink(`${site.url}/about`);
    expect(r).toMatchObject({ status: 200, chain: [], loop: false });
  });

  it("records every hop of a redirect chain", async () => {
    const r = await checkLink(`${site.url}/old`);
    expect(r.status).toBe(200);
    expect(r.chain.map((h) => new URL(h.url).pathname)).toEqual(["/old", "/old-2", "/old-3"]);
    expect(new URL(r.finalUrl!).pathname).toBe("/new-arrivals");
  });

  it("detects redirect loops", async () => {
    const r = await checkLink(`${site.url}/loop-a`);
    expect(r.loop).toBe(true);
  });

  it("reports 404 and 429 as statuses, not as errors", async () => {
    expect((await checkLink(`${site.url}/missing-page`)).status).toBe(404);
    expect((await checkLink(`${site.extUrl}/limited`)).status).toBe(429);
  });

  it("reports network failures as an error result instead of throwing", async () => {
    const r = await checkLink("http://127.0.0.1:1/", { timeoutMs: 2000 });
    expect(r.status).toBeUndefined();
    expect(r.error).toBeDefined();
    expect((await checkLink("not a url")).error).toBe("invalid");
  });
});

describe("checkLinks", () => {
  it("checks each URL once and fills the cache", async () => {
    const cache = new Map<string, LinkCheck>();
    const urls = [`${site.url}/about`, `${site.url}/about`, `${site.url}/cart`];
    await checkLinks(urls, cache);
    expect([...cache.keys()].sort()).toEqual([`${site.url}/about`, `${site.url}/cart`]);
  });
});
