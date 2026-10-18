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
const cli = (args: string[]) =>
  run(process.execPath, ["--import", "tsx", "src/main.ts", ...args], { cwd }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

let site: DemoSite;
const out = mkdtempSync(join(tmpdir(), "wd-cli-"));

beforeAll(async () => {
  site = await startDemoSite({ mode: "broken" });
});
afterAll(async () => {
  await site.close();
  rmSync(out, { recursive: true, force: true });
});

describe("webdoctor CLI (real process)", () => {
  it("scans with the default formats, including the AI fix prompt", async () => {
    const res = await cli([
      "scan",
      site.url,
      "--out",
      out,
      "--max-pages",
      "4",
      "--viewport",
      "desktop",
      "--ci",
    ]);
    // 3 = partial because of --max-pages; the point is that the defaults are accepted
    expect([0, 3]).toContain(res.code);
    expect(res.stderr).not.toContain("error:");
    expect(res.stdout).toContain("Fix prompt for an AI agent:");

    const runDir = res.stdout.match(/Fix prompt for an AI agent: (.+)fix-prompt\.md/)![1]!;
    for (const f of ["report.json", "issues.csv", "report.html", "fix-prompt.md"]) {
      expect(existsSync(join(runDir, f)), f).toBe(true);
    }
    expect(readFileSync(join(runDir, "fix-prompt.md"), "utf8")).toContain("## Ground rules");
  }, 120_000);

  it("exports the fix prompt of the latest run to stdout and to a file", async () => {
    const stdout = await cli(["export", "--dir", out]);
    expect(stdout.code).toBe(0);
    expect(stdout.stdout).toContain("# Fix the problems found on");

    const file = join(out, "task.md");
    const toFile = await cli(["export", "--dir", out, "--out", file, "--max-findings", "3"]);
    expect(toFile.code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("## Your task");
  }, 60_000);

  it("rejects an unknown format with exit code 2", async () => {
    const res = await cli(["scan", site.url, "--out", out, "--format", "pdf"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--format");
  }, 60_000);

  it("exports from an empty directory with a helpful error", async () => {
    const res = await cli(["export", "--dir", join(out, "nothing-here")]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no runs found");
  }, 60_000);
});
