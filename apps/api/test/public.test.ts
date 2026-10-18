import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Report } from "@webdoctor/core";
import type { NetworkGuard } from "@webdoctor/netguard";
import type { RunScanOptions, RunScanResult } from "@webdoctor/runner";
import { openStore } from "@webdoctor/storage";
import type { FastifyInstance } from "fastify";
import { RateLimiter, SessionTokens, sweepRetention } from "../src/limits";
import { createApiServer } from "../src/server";
import type { Verifier } from "../src/server";

const SECRET = "test-secret";
const sessions = new SessionTokens(Buffer.from(SECRET));
const bearer = (token: string) => ({ "x-webdoctor-token": token });

const report = (id: string, startedAt = new Date().toISOString()): Report => ({
  schemaVersion: SCHEMA_VERSION,
  run: {
    id,
    status: "completed",
    settings: {
      startUrl: "https://shop.example.com/",
      maxPages: 5,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["seo"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt,
    partial: false,
  },
  pages: [],
  issues: [],
  groups: [],
});

const scanCalls: RunScanOptions[] = [];
const closed: string[] = [];
let nextError: Error | undefined;

async function fakeScan(options: RunScanOptions): Promise<RunScanResult> {
  scanCalls.push(options);
  if (nextError) {
    const e = nextError;
    nextError = undefined;
    throw e;
  }
  await new Promise<void>((resolve) => {
    options.signal?.addEventListener("abort", () => resolve());
  });
  return { report: report("run-fake"), runDir: "", files: [] };
}

const fakeGuard = async (): Promise<NetworkGuard> => ({
  policy: {} as NetworkGuard["policy"],
  checkUrl: async () => undefined,
  fetch: (async () => new Response("")) as NetworkGuard["fetch"],
  browser: { proxy: { server: "http://127.0.0.1:1" }, args: [] },
  stats: () => ({ bytes: 0, blocked: [], budgetExceeded: false }),
  close: async () => void closed.push("guard"),
});

const verifierCalls: unknown[] = [];
const verifier: Verifier = {
  issues: async (_s, runId, ids, guard) => {
    verifierCalls.push({ runId, ids, guarded: Boolean(guard) });
    return { verifications: [], issues: [] } as never;
  },
  group: async () => ({}) as never,
};

let dir: string;
let app: FastifyInstance;
const tokenA = sessions.issue();
const tokenB = sessions.issue();
const ownerA = sessions.verify(tokenA)!;
const ownerB = sessions.verify(tokenB)!;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wd-pub-"));
  const store = openStore(join(dir, "webdoctor.db"));
  store.saveReport(report("run-a"), ownerA);
  store.saveReport(report("run-b"), ownerB);
  store.saveReport(report("run-local")); // made in local mode: nobody in public mode may see it
  store.close();
  for (const id of ["run-a", "run-b"]) {
    mkdirSync(join(dir, "runs", id, "screenshots"), { recursive: true });
    writeFileSync(join(dir, "runs", id, "screenshots", "s.webp"), "bytes");
  }
  app = await createApiServer({
    dataDir: dir,
    scanRunner: fakeScan,
    verifier,
    public: {
      secret: SECRET,
      examples: ["https://example.com"],
      createGuard: fakeGuard as never,
      limits: { sessionsPerIpPerHour: 3, maxPages: 15, maxDepth: 2 },
    },
  });
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("host names", () => {
  it("answers only for the configured public names, except the health check", async () => {
    const strict = await createApiServer({
      dataDir: dir,
      public: { secret: SECRET, allowedHosts: ["doctor.example.com"] },
    });
    try {
      const at = (host: string, url: string) => strict.inject({ url, headers: { host } });
      expect((await at("doctor.example.com", "/api/config")).statusCode).toBe(200);
      expect((await at("evil.test", "/api/config")).statusCode).toBe(403);
      expect((await at("127.0.0.1:8080", "/api/health")).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });
});

describe("sessions", () => {
  it("serves health and config without a session, and says it is public", async () => {
    expect((await app.inject("/api/health")).json()).toEqual({ ok: true, mode: "public" });
    const config = (await app.inject("/api/config")).json();
    expect(config).toMatchObject({ mode: "public", limits: { maxPages: 15, maxDepth: 2 } });
    expect(config.examples).toEqual(["https://example.com"]);
    expect(config.disclaimer).toContain("permission");
  });

  it("refuses everything else without a valid session", async () => {
    for (const url of ["/api/runs", "/api/runs/run-a", "/api/scans"]) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    expect((await app.inject({ url: "/api/runs", headers: bearer("garbage") })).statusCode).toBe(
      401,
    );
    // a token that looks right but was signed with another secret
    const forged = new SessionTokens(Buffer.from("other")).issue();
    expect((await app.inject({ url: "/api/runs", headers: bearer(forged) })).statusCode).toBe(401);
    // a real token with the id swapped keeps the old signature and fails
    const [, sig] = tokenA.split(".");
    const swapped = `${"0".repeat(32)}.${sig}`;
    expect((await app.inject({ url: "/api/runs", headers: bearer(swapped) })).statusCode).toBe(401);
  });

  it("issues a working session and limits how many one address can create", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/session",
        remoteAddress: "203.0.113.7",
      });
      expect(res.statusCode).toBe(201);
      created.push(res.json().token);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/session",
      remoteAddress: "203.0.113.7",
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // another address is not affected, and the issued token is accepted
    const other = await app.inject({
      method: "POST",
      url: "/api/session",
      remoteAddress: "203.0.113.8",
    });
    expect(other.statusCode).toBe(201);
    const ok = await app.inject({ url: "/api/runs", headers: bearer(created[0]!) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([]);
  });

  it("also accepts the session as ?token= (needed for <img> requests)", async () => {
    const res = await app.inject({
      url: `/api/runs/run-a/artifacts/screenshots/s.webp?token=${tokenA}`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("isolation between visitors", () => {
  it("lists only the visitor's own runs", async () => {
    const a = (await app.inject({ url: "/api/runs", headers: bearer(tokenA) })).json();
    const b = (await app.inject({ url: "/api/runs", headers: bearer(tokenB) })).json();
    expect(a.map((r: { id: string }) => r.id)).toEqual(["run-a"]);
    expect(b.map((r: { id: string }) => r.id)).toEqual(["run-b"]);
  });

  it("answers 404 (not 403) for someone else's run on every route", async () => {
    const routes = [
      "/api/runs/run-b",
      "/api/runs/run-b/verifications",
      "/api/runs/run-b/fix-prompt.md",
      "/api/runs/run-b/artifacts/screenshots/s.webp",
      "/api/runs/run-local",
      "/api/runs/run-missing",
    ];
    for (const url of routes) {
      expect((await app.inject({ url, headers: bearer(tokenA) })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ url: "/api/runs/run-a", headers: bearer(tokenA) })).statusCode).toBe(
      200,
    );
    const verify = await app.inject({
      method: "POST",
      url: "/api/runs/run-b/issues/x/verify",
      headers: bearer(tokenA),
    });
    expect(verify.statusCode).toBe(404);
  });

  it("verifies through a guard for the run's owner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/run-a/issues/i1/verify",
      headers: bearer(tokenA),
    });
    expect(res.statusCode).toBe(200);
    expect(verifierCalls.at(-1)).toMatchObject({ runId: "run-a", guarded: true });
    expect(closed.length).toBeGreaterThan(0);
  });
});

describe("starting scans", () => {
  const start = (token: string, body: object, ip = "198.51.100.1") =>
    app.inject({
      method: "POST",
      url: "/api/scans",
      headers: bearer(token),
      payload: body,
      remoteAddress: ip,
    });

  it("refuses private and internal targets immediately, without starting anything", async () => {
    const before = scanCalls.length;
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:3000",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://2130706433/",
      "http://intranet/",
      "https://user:pw@example.com/",
      "http://example.com:22/",
    ]) {
      const res = await start(tokenA, { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toMatch(/\S/);
    }
    expect(scanCalls.length).toBe(before);
  });

  it("clamps the settings, forces robots.txt, and runs the scan behind a guard", async () => {
    const res = await start(tokenA, {
      url: "https://93.184.216.34/",
      maxPages: 5000,
      maxDepth: 6,
      respectRobots: false,
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => scanCalls.length > 0);
    const call = scanCalls.at(-1)!;
    expect(call).toMatchObject({ maxPages: 15, maxDepth: 2, respectRobots: true, owner: ownerA });
    expect(call.guard).toBeDefined();
    expect(call.timeoutMs).toBe(5 * 60_000);
    expect(call.maxExternalLinks).toBe(30);
  });

  it("allows one scan at a time per visitor, and hides the scan from others", async () => {
    const second = await start(tokenA, { url: "https://93.184.216.34/" });
    expect(second.statusCode).toBe(429);
    const list = (await app.inject({ url: "/api/scans", headers: bearer(tokenA) })).json();
    expect(list).toHaveLength(1);
    const id = list[0].id;
    expect(
      (await app.inject({ url: `/api/scans/${id}`, headers: bearer(tokenB) })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/scans/${id}/cancel`,
          headers: bearer(tokenB),
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/scans", headers: bearer(tokenB) })).json()).toEqual([]);
    // the owner can cancel; the guard is released afterwards
    const before = closed.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/scans/${id}/cancel`,
          headers: bearer(tokenA),
        })
      ).statusCode,
    ).toBe(200);
    await waitFor(() => closed.length > before);
  });

  it("shows a safe message when a scan fails for an internal reason", async () => {
    nextError = new Error("ECONNREFUSED 10.1.2.3:5432 secret-host");
    const res = await start(tokenB, { url: "https://93.184.216.34/" }, "198.51.100.2");
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    await waitFor(async () => {
      const job = (await app.inject({ url: `/api/scans/${id}`, headers: bearer(tokenB) })).json();
      return job.status === "failed";
    });
    const job = (await app.inject({ url: `/api/scans/${id}`, headers: bearer(tokenB) })).json();
    expect(job.error).toBe("The scan could not be completed.");
    expect(JSON.stringify(job)).not.toContain("secret-host");
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

describe("limits helpers", () => {
  it("RateLimiter counts inside a sliding window and reports when to retry", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.take("k")).toBe(true);
    expect(limiter.take("k")).toBe(true);
    expect(limiter.take("k")).toBe(false);
    expect(limiter.retryAfter("k")).toBe(1);
    expect(limiter.take("other")).toBe(true);
    now = 1001;
    expect(limiter.retryAfter("k")).toBe(0);
    expect(limiter.take("k")).toBe(true);
  });

  it("SessionTokens rejects malformed input of any kind", () => {
    for (const bad of [
      undefined,
      42,
      "",
      "a.b",
      "x".repeat(500),
      `${"a".repeat(32)}.`,
      `${tokenA}.extra`,
      [tokenA],
    ]) {
      expect(sessions.verify(bad), String(bad)).toBeUndefined();
    }
    expect(sessions.verify(tokenA)).toBe(ownerA);
    expect(ownerA).not.toContain(tokenA.split(".")[0]!);
  });

  it("sweepRetention removes old runs from the database and from disk", () => {
    const d = mkdtempSync(join(tmpdir(), "wd-ret-"));
    try {
      const store = openStore(join(d, "webdoctor.db"));
      store.saveReport(report("old", "2026-01-01T00:00:00.000Z"));
      store.saveReport(report("fresh", "2026-10-17T00:00:00.000Z"));
      for (const id of ["old", "fresh"]) {
        mkdirSync(join(d, "runs", id), { recursive: true });
        writeFileSync(join(d, "runs", id, "report.json"), "{}");
      }
      expect(sweepRetention(store, d, "2026-06-01T00:00:00.000Z")).toEqual(["old"]);
      expect(existsSync(join(d, "runs", "old"))).toBe(false);
      expect(existsSync(join(d, "runs", "fresh", "report.json"))).toBe(true);
      expect(store.getReport("old")).toBeUndefined();
      store.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
