/**
 * Regenerates the screenshots and GIFs in docs/screenshots from the real product: it scans the
 * bundled demo site, starts the inspector and drives it with Playwright.
 *
 *   pnpm docs:capture                      # everything (about ten minutes)
 *   SCENES=shots,gif-verify pnpm docs:capture
 *   DOCS_DATA=/some/dir pnpm docs:capture  # reuse the scan data of an earlier run
 *   SKIP_BUILD=1 ...                       # do not rebuild the UI
 *
 * Scenes: shots, radar, gif-inspector, gif-verify, gif-radar, gif-scan, gif-public
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { runScan } from "@webdoctor/runner";
import { log, root, serve } from "./capture-lib";
import type { Api } from "./capture-lib";
import { runScenes } from "./capture-scenes";
import type { Ctx } from "./capture-scenes";

async function main(): Promise<void> {
  if (!process.env.SKIP_BUILD) {
    log("building the inspector UI");
    await promisify(execFile)("pnpm", ["--filter", "@webdoctor/web", "build"], {
      cwd: root,
      shell: process.platform === "win32",
    });
  }
  const webDir = join(root, "apps/web/dist");

  const reuse = process.env.DOCS_DATA;
  const data = reuse ?? mkdtempSync(join(tmpdir(), "wd-docs-"));
  const dirs = {
    main: join(data, "main"),
    radar: join(data, "radar"),
    verify: join(data, "verify"),
    scan: join(data, "scan"),
    public: join(data, "public"),
  };

  let site: DemoSite;
  try {
    site = await startDemoSite({ mode: "broken", port: 4000, extPort: 4001 });
  } catch {
    site = await startDemoSite({ mode: "broken" });
  }
  log(`demo site on ${site.url}`);

  const ids: Ctx["ids"] = {};
  const idsFile = join(data, "ids.json");
  if (!existsSync(idsFile)) {
    const scan = async (dir: string) =>
      (await runScan({ url: site.url, outDir: dir, formats: ["json"] })).report.run.id;
    log("scan 1/4: demo site, first look");
    ids.main = await scan(dirs.main);
    cpSync(dirs.main, dirs.verify, { recursive: true }); // verify.gif changes its copy, not this
    log("scan 2/4: history, broken");
    ids.broken1 = await scan(dirs.radar);
    site.setMode("fixed");
    log("scan 3/4: history, fixed");
    ids.fixed = await scan(dirs.radar);
    site.setMode("broken");
    log("scan 4/4: history, broken again");
    ids.broken2 = await scan(dirs.radar);
    writeFileSync(idsFile, JSON.stringify(ids));
  } else {
    Object.assign(ids, JSON.parse(readFileSync(idsFile, "utf8")));
    log("reusing scan data");
  }

  const apps: Api[] = [];
  const start: Ctx["start"] = async (options) => {
    const s = await serve({ token: "docs", webDir, ...options });
    apps.push(s.app);
    return s;
  };
  const browser = await chromium.launch();
  try {
    await runScenes({ browser, site, ids, dirs, start });
  } finally {
    await browser.close();
    for (const app of apps) await app.close();
    await site.close();
    if (!reuse) rmSync(data, { recursive: true, force: true });
  }
}

await main();
