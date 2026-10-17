import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Report } from "@webdoctor/core";
import type { RunScanOptions, RunScanResult } from "@webdoctor/runner";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/server";
import { MAX_SCAN_PAGES, scanTimeoutMs } from "../src/scans";

const TOKEN = "t";
const auth = { "x-webdoctor-token": TOKEN };

const report = (url: string, partial = false): Report => ({
  schemaVersion: SCHEMA_VERSION,
  run: {
    id: "run-new",
    status: "completed",
    settings: {
      startUrl: url,
      maxPages: 5,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["seo"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt: "2026-10-18T10:00:00.000Z",
    partial,
  },
  pages: [],
  issues: [],
  groups: [],
});

/** A scan the test controls: it reports progress, then waits until released or aborted. */
const calls: RunScanOptions[] = [];
let release: (() => void) | undefined;
let failNext: string | undefined;

async function fakeScan(options: RunScanOptions): Promise<RunScanResult> {
  calls.push(options);
  if (failNext) {
    const message = failNext;
    failNext = undefined;
    throw new Error(message);
  }
  options.onProgress?.({
    type: "page",
    url: `${options.url}a`,
    viewport: "desktop",
    done: 1,
    queued: 2,
  });
  options.onProgress?.({
    type: "page",
    url: `${options.url}a`,
    viewport: "mobile",
    done: 2,
    queued: 2,
  });
  options.onProgress?.({ type: "skipped", url: `${options.url}gone`, reason: "http-error" });
  if (options.url.includes("hold")) {
    await new Promise<void>((resolve) => {
      release = resolve;
      options.signal?.addEventListener("abort", () => resolve());
    });
  }
  options.onProgress?.({ type: "links", total: 7 });
  return { report: report(options.url, options.signal?.aborted), runDir: "x", files: [] };
}

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wd-scans-"));
  app = await createApiServer({ dataDir: dir, token: TOKEN, scanRunner: fakeScan });
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url, headers, payload: payload as object | undefined });
const get = (url: string) => app.inject({ url, headers: auth });
const until = async (id: string, done: (s: string) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const job = (await get(`/api/scans/${id}`)).json();
    if (done(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for the scan");
};

describe("POST /api/scans", () => {
  it("requires the token", async () => {
    expect((await post("/api/scans", { url: "https://a.test/" }, {})).statusCode).toBe(401);
  });

  it("rejects addresses that are not http(s) with a readable message", async () => {
    for (const url of [
      "",
      "example.com",
      "ftp://a.test",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      const res = await post("/api/scans", { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toContain("http(s)");
    }
    expect((await post("/api/scans", { url: "https://a.test/", maxPages: 99999 })).statusCode).toBe(
      400,
    );
    expect((await post("/api/scans", { url: "https://a.test/", viewports: [] })).statusCode).toBe(
      400,
    );
    expect(calls).toHaveLength(0);
  });

  it("starts a scan with defaults, reports progress and links the finished run", async () => {
    const res = await post("/api/scans", { url: "https://a.test/" });
    expect(res.statusCode).toBe(202);
    const started = res.json();
    expect(started).toMatchObject({
      url: "https://a.test/",
      status: expect.stringMatching(/queued|running/),
    });

    const job = await until(started.id, (s) => s === "completed");
    expect(job).toMatchObject({
      pagesDone: 1, // the same page on two viewports counts once
      skipped: 1,
      linkTargets: 7,
      runId: "run-new",
      partial: false,
      failCount: 0,
      phase: "done",
    });
    expect(calls[0]).toMatchObject({
      url: "https://a.test/",
      maxPages: 50,
      maxDepth: 3,
      viewports: ["desktop", "mobile"],
      respectRobots: true,
      outDir: dir,
    });
  });

  it("reports a failed scan with its message instead of crashing", async () => {
    failNext = "Invalid start URL";
    const { id } = (await post("/api/scans", { url: "https://b.test/" })).json();
    const job = await until(id, (s) => s === "failed");
    expect(job.error).toBe("Invalid start URL");
  });

  it("runs one scan at a time, queues the next and refuses a long backlog", async () => {
    const first = (await post("/api/scans", { url: "https://hold.test/1" })).json();
    await until(first.id, (s) => s === "running");
    const second = (await post("/api/scans", { url: "https://a.test/2" })).json();
    const third = (await post("/api/scans", { url: "https://a.test/3" })).json();
    expect((await get(`/api/scans/${second.id}`)).json().status).toBe("queued");

    expect((await post("/api/scans", { url: "https://a.test/4" })).statusCode).toBe(429);

    release?.();
    await until(second.id, (s) => s === "completed");
    await until(third.id, (s) => s === "completed");
    expect((await get(`/api/scans/${first.id}`)).json().status).toBe("completed");
  });

  it("cancels a queued scan outright and stops a running one gracefully", async () => {
    const running = (await post("/api/scans", { url: "https://hold.test/run" })).json();
    await until(running.id, (s) => s === "running");
    const queued = (await post("/api/scans", { url: "https://a.test/q" })).json();

    expect((await post(`/api/scans/${queued.id}/cancel`)).json().status).toBe("canceled");
    await post(`/api/scans/${running.id}/cancel`);
    const stopped = await until(running.id, (s) => s !== "running");
    // the partial result is still saved and linked
    expect(stopped).toMatchObject({ status: "canceled", partial: true, runId: "run-new" });
    // the canceled queued scan never started
    expect(calls.some((c) => c.url === "https://a.test/q")).toBe(false);
  });

  it("answers 404 for unknown scans and lists recent ones", async () => {
    expect((await get("/api/scans/nope")).statusCode).toBe(404);
    expect((await post("/api/scans/nope/cancel")).statusCode).toBe(404);
    const list = (await get("/api/scans")).json();
    expect(list.length).toBeGreaterThan(3);
  });
});

describe("GET /api/runs/:id/fix-prompt.md", () => {
  it("is 404 for a run that does not exist and needs the token", async () => {
    expect((await get("/api/runs/none/fix-prompt.md")).statusCode).toBe(404);
    expect((await app.inject("/api/runs/none/fix-prompt.md")).statusCode).toBe(401);
  });
});

describe("scan limits", () => {
  it("accepts up to 5000 pages and refuses more", async () => {
    expect(MAX_SCAN_PAGES).toBe(5000);
    expect((await post("/api/scans", { url: "https://a.test/", maxPages: 5001 })).statusCode).toBe(
      400,
    );
    const ok = await post("/api/scans", { url: "https://a.test/big", maxPages: 5000 });
    expect(ok.statusCode).toBe(202);
    await until(ok.json().id, (s) => s === "completed");
    expect(calls.at(-1)).toMatchObject({ url: "https://a.test/big", maxPages: 5000 });
  });

  it("gives a big scan a proportionate time budget, within sane bounds", () => {
    expect(scanTimeoutMs(10, 2)).toBe(10 * 60_000); // never less than 10 minutes
    expect(scanTimeoutMs(500, 2)).toBe(500 * 2 * 4000);
    expect(scanTimeoutMs(5000, 2)).toBe(4 * 3600_000); // never more than 4 hours
    expect(calls.at(-1)!.timeoutMs).toBe(4 * 3600_000);
  });

  it("reports the latest pages (newest first) and the queue size for the live view", async () => {
    const started = (await post("/api/scans", { url: "https://hold.test/live" })).json();
    await until(started.id, (s) => s === "running");
    const job = (await get(`/api/scans/${started.id}`)).json();
    expect(job.recent).toEqual(["https://hold.test/livea"]);
    expect(job.queued).toBe(2);
    expect(job.startedAt).toBeDefined();
    release?.();
    await until(started.id, (s) => s === "completed");
  });
});
