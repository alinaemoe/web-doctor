import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoSite } from "@webdoctor/demo-site";
import { FsArtifactStore, scan } from "../src/index";

const site = await startDemoSite({ mode: "broken" });
const dir = mkdtempSync(join(tmpdir(), "wd-smoke-"));
const t = Date.now();
const result = await scan({
  startUrl: site.url,
  artifacts: new FsArtifactStore(dir),
  onProgress: (e) => e.type === "page" && console.log("page", e.viewport, e.url),
});
console.log(
  `pages=${result.pages.length} skipped=${result.skipped.length} links=${Object.keys(result.linkChecks).length} partial=${result.partial} ${Date.now() - t}ms`,
);
const p = result.pages.find((x) => x.url.endsWith("/checkout") && x.viewport === "desktop");
console.log(
  JSON.stringify({
    axe: p?.axe.map((a) => [a.id, a.nodes.length]),
    shot: p?.screenshotKey,
    console: p?.console,
  }),
);
const cart = result.pages.find((x) => x.url.endsWith("/cart") && x.viewport === "desktop");
console.log("cart console", cart?.console);
console.log("skipped", result.skipped);
await site.close();
