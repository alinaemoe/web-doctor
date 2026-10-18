import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { FsArtifactStore } from "./artifacts";
import { collectPage, launchBrowser } from "./index";
import type { BrowserHandle } from "./index";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let site: DemoSite;
let browser: BrowserHandle;
const dir = mkdtempSync(join(tmpdir(), "wd-collect-"));

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("collectPage on a real browser", () => {
  it("names the element that causes horizontal overflow, not the containers around it", async () => {
    const result = await collectPage(browser, `${site.url}/size-guide`, {
      viewport: "mobile",
      depth: 0,
      artifacts: new FsArtifactStore(dir),
      pageTimeoutMs: 20_000,
      screenshot: false,
      axe: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { offenders, scrollWidth, clientWidth } = result.snapshot.overflowX;
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders[0]!.htmlSnippet).toContain("size-table");
    // <main> and <body> contain the wide block but are not the cause
    expect(offenders.map((o) => o.selector)).not.toContain("body > main");
    expect(offenders.every((o) => !/^<(main|body|html)\b/.test(o.htmlSnippet))).toBe(true);
  }, 60_000);

  it("skips screenshots and axe when asked, and probes selectors", async () => {
    const result = await collectPage(browser, `${site.url}/about`, {
      viewport: "desktop",
      depth: 0,
      artifacts: new FsArtifactStore(dir),
      pageTimeoutMs: 20_000,
      screenshot: false,
      axe: false,
      probes: ["h1", ".does-not-exist", "div["],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.screenshotKey).toBeUndefined();
    expect(result.snapshot.axe).toEqual([]);
    expect(result.snapshot.probes).toEqual({ h1: true, ".does-not-exist": false, "div[": false });
  }, 60_000);

  it("reports a navigation failure as data, not as an exception", async () => {
    const result = await collectPage(browser, "http://127.0.0.1:1/", {
      viewport: "desktop",
      depth: 0,
      artifacts: new FsArtifactStore(dir),
      pageTimeoutMs: 5000,
      screenshot: false,
      axe: false,
    });
    expect(result).toMatchObject({ ok: false, reason: "navigation-error" });
  }, 60_000);
});
