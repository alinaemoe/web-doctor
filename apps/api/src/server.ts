import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import { toFixPrompt } from "@webdoctor/runner";
import { ScanManager, StartScanSchema } from "./scans";
import type { ScanFn } from "./scans";
import { openStore } from "@webdoctor/storage";
import type { Store } from "@webdoctor/storage";
import { VerifyInputError, verifyAndSave, verifyGroupAndSave } from "@webdoctor/verify";
import type { GroupVerifyResult, VerifyRunResult } from "@webdoctor/verify";

/** What the API runs for "Re-verify". Replaceable so tests do not need a browser. */
export interface Verifier {
  issues(store: Store, runId: string, issueIds: string[]): Promise<VerifyRunResult>;
  group(store: Store, runId: string, groupId: string, limit: number): Promise<GroupVerifyResult>;
}

const defaultVerifier: Verifier = {
  issues: (store, runId, ids) => verifyAndSave(store, runId, ids, { pageTimeoutMs: 20_000 }),
  group: (store, runId, groupId, limit) =>
    verifyGroupAndSave(store, runId, groupId, limit, { pageTimeoutMs: 20_000 }),
};

/** Verifications are heavy (a real browser): run one at a time and refuse a long backlog. */
const MAX_PENDING_VERIFICATIONS = 3;

export interface ApiOptions {
  /** Directory with `webdoctor.db` and `runs/` (the CLI's `--out`). */
  dataDir: string;
  /** Required on every `/api/*` request (header `x-webdoctor-token` or `?token=`). */
  token: string;
  /** Built web UI to serve at `/` (optional). */
  webDir?: string;
  logger?: boolean;
  verifier?: Verifier;
  /** Test seam for scans started from the UI. */
  scanRunner?: ScanFn;
}

const RUN_ID = /^[\w-]{1,100}$/;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Local-only API. Defense in depth for a tool that scans arbitrary sites on the user's machine:
 *  - callers must present the session token (timing-safe compare),
 *  - the Host header must be a loopback name (blocks DNS rebinding),
 *  - no CORS headers are sent, so other origins cannot read responses,
 *  - only files under `runs/<id>/screenshots/` can be read.
 */
export async function createApiServer(options: ApiOptions): Promise<FastifyInstance> {
  if (!options.token) throw new Error("A non-empty token is required");
  const dataDir = resolve(options.dataDir);
  const store = openStore(join(dataDir, "webdoctor.db"));
  const expected = digest(options.token);

  const app = Fastify({ logger: options.logger ?? false });
  app.addHook("onClose", async () => store.close());

  app.addHook("onRequest", async (req, reply) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(hostname)) {
      return reply.code(403).send({ error: "forbidden host" });
    }
    if (!req.url.startsWith("/api/") || req.url === "/api/health") return;

    const query = req.query as { token?: string } | undefined;
    const presented = req.headers["x-webdoctor-token"] ?? query?.token;
    const ok = typeof presented === "string" && timingSafeEqual(digest(presented), expected);
    if (!ok) return reply.code(401).send({ error: "missing or invalid token" });
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/runs", async () => store.listRuns());

  app.get<{ Params: { id: string }; Querystring: { includeFixed?: string; maxFindings?: string } }>(
    "/api/runs/:id/fix-prompt.md",
    async (req, reply) => {
      if (!RUN_ID.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
      const report = store.getReport(req.params.id);
      if (!report) return reply.code(404).send({ error: "run not found" });
      const maxFindings = Number(req.query.maxFindings);
      const md = toFixPrompt(report, {
        includeFixed: req.query.includeFixed === "1",
        maxFindings:
          Number.isFinite(maxFindings) && maxFindings > 0 ? Math.min(maxFindings, 500) : undefined,
      });
      return reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename="fix-prompt-${req.params.id}.md"`)
        .send(md);
    },
  );

  app.get<{ Params: { id: string } }>("/api/runs/:id/verifications", async (req, reply) => {
    if (!RUN_ID.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    return store.listVerifications(req.params.id);
  });

  // ---- Scans started from the UI (local mode: any http(s) address, including localhost) ----
  const scans = new ScanManager({ dataDir, run: options.scanRunner });

  app.post("/api/scans", async (req, reply) => {
    const parsed = StartScanSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid scan settings";
      return reply.code(400).send({ error: message });
    }
    const job = scans.start(parsed.data);
    if (job === "busy") {
      return reply
        .code(429)
        .send({ error: "Too many scans waiting. Try again when one has finished." });
    }
    return reply.code(202).send(job);
  });

  app.get("/api/scans", async () => scans.list());

  app.get<{ Params: { id: string } }>("/api/scans/:id", async (req, reply) => {
    const job = scans.get(req.params.id);
    return job ?? reply.code(404).send({ error: "scan not found" });
  });

  app.post<{ Params: { id: string } }>("/api/scans/:id/cancel", async (req, reply) => {
    const job = scans.cancel(req.params.id);
    return job ?? reply.code(404).send({ error: "scan not found" });
  });

  // ---- Verify Fix ----
  const verifier = options.verifier ?? defaultVerifier;
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const enqueue = async <T>(job: () => Promise<T>): Promise<T | "busy"> => {
    if (pending >= MAX_PENDING_VERIFICATIONS) return "busy";
    pending++;
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      pending--;
    }
  };

  const respond = async <T>(reply: FastifyReply, job: () => Promise<T>): Promise<unknown> => {
    try {
      const result = await enqueue(job);
      if (result === "busy") {
        return reply.code(429).send({ error: "Too many verifications queued. Try again shortly." });
      }
      return result;
    } catch (error) {
      if (error instanceof VerifyInputError) return reply.code(404).send({ error: error.message });
      app.log.error(error);
      return reply.code(500).send({ error: "Verification failed. See the server log." });
    }
  };

  app.post<{ Params: { id: string; issueId: string } }>(
    "/api/runs/:id/issues/:issueId/verify",
    async (req, reply) => {
      const { id, issueId } = req.params;
      if (!RUN_ID.test(id) || !RUN_ID.test(issueId)) {
        return reply.code(400).send({ error: "bad id" });
      }
      return respond(reply, () => verifier.issues(store, id, [issueId]));
    },
  );

  app.post<{ Params: { id: string; groupId: string }; Body: { limit?: number } | undefined }>(
    "/api/runs/:id/groups/:groupId/verify",
    async (req, reply) => {
      const { id, groupId } = req.params;
      if (!RUN_ID.test(id) || !RUN_ID.test(groupId)) {
        return reply.code(400).send({ error: "bad id" });
      }
      const requested = Number(req.body?.limit ?? 5);
      const limit = Number.isFinite(requested)
        ? Math.min(10, Math.max(1, Math.floor(requested)))
        : 5;
      return respond(reply, () => verifier.group(store, id, groupId, limit));
    },
  );

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    if (!RUN_ID.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    const report = store.getReport(req.params.id);
    if (!report) return reply.code(404).send({ error: "run not found" });
    return report;
  });

  app.get<{ Params: { id: string; "*": string } }>(
    "/api/runs/:id/artifacts/*",
    async (req, reply) => {
      const { id } = req.params;
      const key = req.params["*"];
      if (!RUN_ID.test(id)) return reply.code(400).send({ error: "bad run id" });

      const runDir = resolve(dataDir, "runs", id);
      const screenshots = join(runDir, "screenshots") + sep;
      const file = resolve(runDir, key);
      const type = CONTENT_TYPES[extname(file).toLowerCase()];
      if (!type || !file.startsWith(screenshots)) {
        return reply.code(404).send({ error: "artifact not found" });
      }
      try {
        const data = await readFile(file);
        return reply
          .header("content-type", type)
          .header("cache-control", "private, max-age=31536000, immutable")
          .send(data);
      } catch {
        return reply.code(404).send({ error: "artifact not found" });
      }
    },
  );

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: resolve(options.webDir) });
  } else {
    app.get("/", async (_req, reply) =>
      reply
        .type("text/plain")
        .send("Web Doctor API is running. Build the UI with: pnpm --filter @webdoctor/web build"),
    );
  }

  return app;
}
