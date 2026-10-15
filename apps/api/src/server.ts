import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { openStore } from "@webdoctor/storage";

export interface ApiOptions {
  /** Directory with `webdoctor.db` and `runs/` (the CLI's `--out`). */
  dataDir: string;
  /** Required on every `/api/*` request (header `x-webdoctor-token` or `?token=`). */
  token: string;
  /** Built web UI to serve at `/` (optional). */
  webDir?: string;
  logger?: boolean;
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
