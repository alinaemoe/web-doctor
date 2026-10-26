import type { Browser, Page } from "playwright";
import type { ApiOptions } from "@webdoctor/api";
import type { DemoSite } from "@webdoctor/demo-site";
import { GIF_VIEW, Recorder, log, open, pause, runPage, shot } from "./capture-lib";
import type { Api } from "./capture-lib";

export interface Ctx {
  browser: Browser;
  site: DemoSite;
  ids: { main?: string; broken1?: string; fixed?: string; broken2?: string };
  dirs: { main: string; radar: string; verify: string; scan: string; public: string };
  start: (options: {
    dataDir: string;
    public?: ApiOptions["public"];
  }) => Promise<{ app: Api; base: string }>;
}

const wanted = new Set((process.env.SCENES ?? "").split(",").filter(Boolean));
const want = (scene: string) => wanted.size === 0 || wanted.has(scene);

const row = (page: Page, text: string) =>
  page.locator(".issue-list .row", { hasText: text }).first();
const tab = (page: Page, name: RegExp) => page.locator(".tabs button", { hasText: name }).first();

async function waitFor(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(250);
  }
  throw new Error("timed out");
}

export async function runScenes(ctx: Ctx): Promise<void> {
  const { browser, site, ids } = ctx;
  const main = await ctx.start({ dataDir: ctx.dirs.main });
  const radar = await ctx.start({ dataDir: ctx.dirs.radar });

  // ---------------------------------------------------------------- stills
  if (want("shots")) {
    log("stills");
    {
      const { page, context } = await open(browser, main.base, runPage(ids.main!));
      await row(page, "Image failed to load").click();
      await pause(400);
      await shot(page, "inspector.png");
      await row(page, "Images must have alternative text").click();
      await pause(400);
      await shot(page, "a11y-issue.png");
      await context.close();
    }
    {
      const { page, context } = await open(browser, main.base, runPage(ids.main!));
      await row(page, "Page scrolls horizontally on mobile").click();
      await pause(500);
      await shot(page, "mobile-viewport.png");
      await context.close();
    }
    {
      const { page, context } = await open(browser, main.base, runPage(ids.main!), {
        scheme: "dark",
      });
      await row(page, "Elements must meet minimum color").click();
      await pause(400);
      await shot(page, "dark-theme.png");
      await context.close();
    }
    {
      const { page, context } = await open(browser, main.base, `${runPage(ids.main!)}/map`, {
        view: { width: 1320, height: 1010 },
      });
      await page.locator(".map-box", { hasText: "/products/backpack" }).first().click();
      await pause(300);
      await shot(page, "site-map.png");
      await context.close();
    }
  }

  if (want("radar")) {
    log("regression radar stills");
    {
      const { page, context } = await open(browser, radar.base, runPage(ids.broken2!));
      await tab(page, /Changes/).click();
      await pause(500);
      await shot(page, "regression-radar.png");
      await context.close();
    }
    {
      const { page, context } = await open(browser, radar.base, "#/", {
        view: { width: 1180, height: 620 },
      });
      await pause(400);
      await shot(page, "runs-history.png");
      await context.close();
    }
  }

  // ----------------------------------------------------------------- GIFs
  if (want("gif-inspector")) {
    log("gif: inspector");
    const { page, context } = await open(browser, main.base, runPage(ids.main!), {
      view: GIF_VIEW,
      scale: 1,
      cursor: true,
    });
    const rec = new Recorder(page);
    await rec.snap(900);
    await rec.click(row(page, "Images must have alternative text"), 700);
    rec.hold(500);
    await rec.click(row(page, "Image failed to load"), 700);
    rec.hold(500);
    await rec.key("j");
    await rec.key("j");
    await rec.click(row(page, "Page scrolls horizontally on mobile"), 800);
    rec.hold(800);
    await rec.click(page.locator(".seg button", { hasText: "Desktop" }), 600);
    await rec.click(row(page, "Form elements must have labels"), 800);
    rec.hold(900);
    await rec.save("inspector.gif", 960);
    await context.close();
  }

  if (want("gif-verify")) {
    log("gif: verify");
    const verify = await ctx.start({ dataDir: ctx.dirs.verify });
    const { page, context } = await open(browser, verify.base, runPage(ids.main!), {
      view: GIF_VIEW,
      scale: 1,
      cursor: true,
    });
    const rec = new Recorder(page);
    await rec.click(row(page, "Image failed to load"), 600);
    rec.hold(1100);
    site.setMode("fixed"); // the "developer" fixes the site
    await rec.snap(500);
    await rec.click(page.getByRole("button", { name: /^Re-verify/ }), 150);
    for (let i = 0; i < 30; i++) {
      await pause(250);
      await rec.snap(160);
      if ((await page.getByRole("button", { name: /Checking/ }).count()) === 0) break;
    }
    rec.hold(2000);
    await tab(page, /Fixed/).hover();
    await rec.click(tab(page, /Fixed/), 900);
    rec.hold(1600);
    await rec.save("verify-fix.gif", 960);
    site.setMode("broken");
    await context.close();
  }

  if (want("gif-radar")) {
    log("gif: regression radar");
    const { page, context } = await open(browser, radar.base, "#/", {
      view: GIF_VIEW,
      scale: 1,
      cursor: true,
    });
    const rec = new Recorder(page);
    await rec.snap(1600);
    const links = page.locator('a[href^="#/runs/"]');
    await rec.click(links.nth(1), 900); // the fixed run
    rec.hold(900);
    await rec.click(tab(page, /Fixed/), 800);
    rec.hold(1500);
    await rec.click(page.getByRole("link", { name: /All runs/ }), 600);
    await rec.click(links.nth(0), 900); // broken again
    rec.hold(900);
    await rec.click(tab(page, /Changes/), 800);
    rec.hold(2000);
    await rec.save("regression-radar.gif", 960);
    await context.close();
  }

  if (want("gif-scan")) {
    log("gif: new scan");
    const local = await ctx.start({ dataDir: ctx.dirs.scan });
    const { page, context } = await open(browser, local.base, "#/new", {
      view: GIF_VIEW,
      scale: 1,
      cursor: true,
    });
    const rec = new Recorder(page);
    await rec.snap(700);
    await rec.type(page.getByLabel("Website address"), "http://127.0.0.1:4000");
    await rec.click(page.getByRole("button", { name: "Scan site" }), 1200);
    // a timelapse: the scan takes about a minute
    for (let i = 0; i < 40; i++) {
      await pause(2500);
      await rec.snap(380);
      if ((await page.getByText(/Done\./).count()) > 0) break;
    }
    rec.hold(1400);
    await rec.click(
      page.getByRole("link", { name: /Open the results|Open results|Open/ }).first(),
      1200,
    );
    rec.hold(1500);
    await rec.save("new-scan.gif", 960);
    await context.close();
  }

  if (want("gif-public")) {
    log("gif: public server refuses private targets");
    const origin = new URL(site.url).origin;
    const pub = await ctx.start({
      dataDir: ctx.dirs.public,
      public: {
        secret: "docs",
        allowOrigins: [origin, new URL(site.extUrl).origin],
        examples: [site.url],
        limits: { maxPages: 10 },
      },
    });
    const { page, context } = await open(browser, pub.base, "#/new", {
      view: GIF_VIEW,
      scale: 1,
      cursor: true,
    });
    const rec = new Recorder(page);
    await rec.snap(1200);
    const address = page.getByLabel("Website address");
    for (const target of [
      "169.254.169.254/latest/meta-data/",
      "localhost:3000/admin",
      "10.0.0.5",
    ]) {
      await address.fill("");
      await rec.type(address, target);
      await rec.click(page.getByRole("button", { name: "Scan site" }), 700);
      await waitFor(async () => (await page.getByRole("alert").count()) > 0, 10_000);
      await rec.snap(200);
      rec.hold(1500);
    }
    await address.fill("");
    await rec.click(page.getByRole("button", { name: site.url }), 500);
    rec.hold(600);
    await rec.click(page.getByRole("button", { name: "Scan site" }), 1500);
    for (let i = 0; i < 6; i++) {
      await pause(1500);
      await rec.snap(500);
    }
    await rec.save("public-ssrf.gif", 960);
    await context.close();
  }
}
