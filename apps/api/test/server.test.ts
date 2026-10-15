import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Report } from "@webdoctor/core";
import { openStore } from "@webdoctor/storage";
import { createApiServer } from "../src/server";
import type { FastifyInstance } from "fastify";

const TOKEN = "test-token";
const auth = { "x-webdoctor-token": TOKEN };
let dir: string;
let app: FastifyInstance;

const report: Report = {
  schemaVersion: SCHEMA_VERSION,
  run: {
    id: "run-1",
    status: "completed",
    settings: {
      startUrl: "http://site.test/",
      maxPages: 5,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["seo"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt: "2026-10-15T10:00:00.000Z",
    partial: false,
  },
  pages: [],
  issues: [
    {
      id: "i1",
      runId: "run-1",
      ruleId: "seo.title.missing",
      category: "seo",
      pageUrl: "http://site.test/",
      viewport: "all",
      title: "Page has no title",
      severity: "high",
      confidence: 1,
      verdict: "fail",
      status: "new",
      evidence: [
        {
          type: "dom",
          selector: "head > title",
          htmlSnippet: "(none)",
          nodeSignature: { domPath: "head > title" },
        },
      ],
      explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
      fingerprint: "0123456789abcdef",
      firstSeenRunId: "run-1",
      lastSeenRunId: "run-1",
      statusHistory: [{ from: null, to: "new", runId: "run-1", at: "2026-10-15T10:00:00.000Z" }],
    },
  ],
  groups: [],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wd-api-"));
  const store = openStore(join(dir, "webdoctor.db"));
  store.saveReport(report);
  store.close();
  mkdirSync(join(dir, "runs", "run-1", "screenshots"), { recursive: true });
  writeFileSync(join(dir, "runs", "run-1", "screenshots", "a.webp"), "webp-bytes");
  writeFileSync(join(dir, "runs", "run-1", "report.json"), "{}");
  writeFileSync(join(dir, "secret.txt"), "top secret");
  app = await createApiServer({ dataDir: dir, token: TOKEN });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth and host checks", () => {
  it("allows /api/health without a token", async () => {
    expect((await app.inject("/api/health")).statusCode).toBe(200);
  });

  it("rejects /api requests without or with a wrong token", async () => {
    expect((await app.inject("/api/runs")).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/runs", headers: { "x-webdoctor-token": "nope" } })).statusCode,
    ).toBe(401);
  });

  it("accepts the token in a header or in the query string (for <img>)", async () => {
    expect((await app.inject({ url: "/api/runs", headers: auth })).statusCode).toBe(200);
    expect((await app.inject(`/api/runs?token=${TOKEN}`)).statusCode).toBe(200);
  });

  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    const res = await app.inject({ url: "/api/health", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(403);
  });

  it("sends security headers and no CORS headers", async () => {
    const res = await app.inject({ url: "/api/runs", headers: auth });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("runs", () => {
  it("lists runs with counts", async () => {
    const res = await app.inject({ url: "/api/runs", headers: auth });
    expect(res.json()).toMatchObject([{ id: "run-1", failCount: 1, unverifiedCount: 0 }]);
  });

  it("returns a full report and 404/400 for bad ids", async () => {
    const ok = await app.inject({ url: "/api/runs/run-1", headers: auth });
    expect(ok.json().issues).toHaveLength(1);
    expect((await app.inject({ url: "/api/runs/unknown", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/runs/..%2Fx", headers: auth })).statusCode).toBe(400);
  });
});

describe("artifacts", () => {
  it("serves screenshots with a cacheable image type", async () => {
    const res = await app.inject({
      url: "/api/runs/run-1/artifacts/screenshots/a.webp",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.body).toBe("webp-bytes");
  });

  it("refuses everything outside runs/<id>/screenshots", async () => {
    for (const path of [
      "report.json",
      "screenshots/missing.webp",
      "screenshots/../report.json",
      "screenshots/..%2f..%2f..%2fsecret.txt",
      "..%2f..%2fsecret.txt",
    ]) {
      const res = await app.inject({ url: `/api/runs/run-1/artifacts/${path}`, headers: auth });
      expect(res.statusCode, path).toBe(404);
      expect(res.body).not.toContain("secret");
    }
  });
});
