import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedManifest, matchExpected, startDemoSite } from "@webdoctor/demo-site";
import { analyze } from "@webdoctor/rules";
import { FsArtifactStore, scan } from "@webdoctor/scanner";

const mode = (process.argv[2] ?? "broken") as "broken" | "fixed";
const site = await startDemoSite({ mode });
const dir = mkdtempSync(join(tmpdir(), "wd-eval-"));
const result = await scan({ startUrl: site.url, artifacts: new FsArtifactStore(dir) });
await site.close();
writeFileSync(join(dir, "scan.json"), JSON.stringify(result));

const { issues, groups } = analyze(result, { runId: "eval" });
const crawled = [...new Set(result.pages.map((p) => new URL(p.url).pathname))];
const m = matchExpected(issues, expectedManifest.modes[mode].issues, crawled);
console.log(`mode=${mode} pages=${crawled.length} issues=${issues.length} groups=${groups.length}`);
console.log(
  `recall=${(m.recall * 100).toFixed(0)}% found=${m.found.length} missing=${m.missing.length} unexpected=${m.unexpected.length}`,
);
for (const x of m.missing) console.log("MISSING", x.ruleId, x.path);
const seen = new Set<string>();
for (const u of m.unexpected) {
  const key = `${u.ruleId} ${new URL(u.pageUrl).pathname}`;
  if (!seen.has(key)) {
    seen.add(key);
    console.log("UNEXPECTED", key, "-", u.title);
  }
}
for (const g of groups.slice(0, 8)) console.log("GROUP", g.ruleId, g.affectedPages, g.signature);
console.log("scan saved to", dir);
