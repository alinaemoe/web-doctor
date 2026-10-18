import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";

const run = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
let site: DemoSite;
const out = mkdtempSync(join(tmpdir(), "wd-ci-"));

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
});
afterAll(async () => {
  await site.close();
  rmSync(out, { recursive: true, force: true });
});

describe("webdoctor scan --ci inside GitHub Actions", () => {
  it("fails the build, annotates the problems and writes the job summary", async () => {
    const summary = join(out, "summary.md");
    const result = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/main.ts",
        "scan",
        site.url,
        "--out",
        out,
        "--max-pages",
        "4",
        "--viewport",
        "desktop",
        "--ci",
        "--fail-on",
        "high",
      ],
      { cwd, env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary } },
    ).then(
      (r) => ({ code: 0, stdout: r.stdout }),
      (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^::error title=/m);
    expect(existsSync(summary)).toBe(true);
    const md = readFileSync(summary, "utf8");
    expect(md).toContain("Web Doctor: ❌ failed");
    expect(md).toContain("| Severity | Problem | Page |");
  }, 120_000);
});
