import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report, Verification } from "@webdoctor/core";
import { openStore } from "@webdoctor/storage";
import { VerifyInputError } from "@webdoctor/verify";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/server";
import type { Verifier } from "../src/server";

const TOKEN = "t";
const auth = { "x-webdoctor-token": TOKEN };

const issue = (id: string): Issue => ({
  id,
  runId: "run-1",
  ruleId: "seo.title.missing",
  category: "seo",
  pageUrl: `http://site.test/${id}`,
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
  fingerprint: `fp-${id}`,
  groupId: "g_1",
  firstSeenRunId: "run-1",
  lastSeenRunId: "run-1",
  statusHistory: [{ from: null, to: "new", runId: "run-1", at: "2026-10-16T09:00:00.000Z" }],
});

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
    startedAt: "2026-10-16T09:00:00.000Z",
    partial: false,
  },
  pages: [],
  issues: [issue("a"), issue("b")],
  groups: [
    {
      id: "g_1",
      runId: "run-1",
      ruleId: "seo.title.missing",
      signature: "s",
      hypothesis: true,
      confidence: 0.6,
      issueIds: ["a", "b"],
      affectedPages: 2,
    },
  ],
};

const ok = (issueId: string): Verification => ({
  issueId,
  outcome: "verified-fixed",
  detail: "The check passes on the current page.",
  checkedAt: "2026-10-16T10:00:00.000Z",
  confidence: 1,
  pages: [],
});

let dir: string;
let app: FastifyInstance;
const calls: string[] = [];
let release: (() => void) | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wd-api-verify-"));
  const store = openStore(join(dir, "webdoctor.db"));
  store.saveReport(report);
  store.close();

  const verifier: Verifier = {
    issues: vi.fn(async (_store, runId, ids) => {
      calls.push(`issues:${runId}:${ids.join(",")}`);
      if (ids[0] === "slow") await new Promise<void>((r) => (release = r));
      if (ids[0] === "missing") throw new VerifyInputError("issue missing not found in run run-1");
      if (ids[0] === "boom") throw new Error("browser exploded: secret-path");
      return {
        results: ids.map(ok),
        issues: ids.map((id: string) => ({ ...issue(id), status: "fixed" as const })),
      };
    }),
    group: vi.fn(async (_store, runId, groupId, limit) => {
      calls.push(`group:${runId}:${groupId}:${limit}`);
      return {
        results: [ok("a")],
        issues: [{ ...issue("a"), status: "fixed" as const }],
        checkedPages: 1,
        totalPages: 2,
      };
    }),
  };
  app = await createApiServer({ dataDir: dir, token: TOKEN, verifier });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url, headers, payload: payload as object | undefined });

describe("POST verify", () => {
  it("requires the token", async () => {
    expect((await post("/api/runs/run-1/issues/a/verify", undefined, {})).statusCode).toBe(401);
  });

  it("verifies one issue and returns results with the updated issue", async () => {
    const res = await post("/api/runs/run-1/issues/a/verify");
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ issueId: "a", outcome: "verified-fixed" });
    expect(res.json().issues[0]).toMatchObject({ id: "a", status: "fixed" });
    expect(calls).toContain("issues:run-1:a");
  });

  it("clamps the group sample size and returns coverage", async () => {
    const res = await post("/api/runs/run-1/groups/g_1/verify", { limit: 500 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ checkedPages: 1, totalPages: 2 });
    expect(calls).toContain("group:run-1:g_1:10");

    await post("/api/runs/run-1/groups/g_1/verify", { limit: "x" });
    expect(calls).toContain("group:run-1:g_1:5");
    await post("/api/runs/run-1/groups/g_1/verify");
    expect(calls.filter((c) => c === "group:run-1:g_1:5")).toHaveLength(2);
  });

  it("maps unknown ids to 404 and hides internal errors", async () => {
    expect((await post("/api/runs/run-1/issues/missing/verify")).statusCode).toBe(404);
    const boom = await post("/api/runs/run-1/issues/boom/verify");
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("secret-path");
    expect((await post("/api/runs/run-1/issues/a%2Fb/verify")).statusCode).toBe(400);
  });

  it("serializes jobs and refuses a long backlog with 429", async () => {
    const first = post("/api/runs/run-1/issues/slow/verify");
    await new Promise((r) => setTimeout(r, 30));
    const queued = [
      post("/api/runs/run-1/issues/a/verify"),
      post("/api/runs/run-1/issues/b/verify"),
    ];
    await new Promise((r) => setTimeout(r, 30));
    const refused = await post("/api/runs/run-1/issues/a/verify");
    expect(refused.statusCode).toBe(429);

    release?.();
    expect((await first).statusCode).toBe(200);
    for (const q of queued) expect((await q).statusCode).toBe(200);
  });

  it("lists stored verifications", async () => {
    const res = await app.inject({ url: "/api/runs/run-1/verifications", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
