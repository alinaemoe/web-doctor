import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GuardError, checkUrl, createNetworkGuard, createPolicy } from "@webdoctor/netguard";
import type { NetworkGuard } from "@webdoctor/netguard";
import { toFixPrompt } from "@webdoctor/runner";
import { RateLimiter, SessionTokens, sweepRetention } from "./limits";
import { ScanManager, StartScanSchema } from "./scans";
import type { ScanFn } from "./scans";
import { openStore } from "@webdoctor/storage";
import type { Store } from "@webdoctor/storage";
import { VerifyInputError, verifyAndSave, verifyGroupAndSave } from "@webdoctor/verify";
import type { GroupVerifyResult, VerifyRunResult } from "@webdoctor/verify";

/** What the API runs for "Re-verify". Replaceable so tests do not need a browser. */
export interface Verifier {
  issues(
    store: Store,
    runId: string,
    issueIds: string[],
    guard?: NetworkGuard,
  ): Promise<VerifyRunResult>;
  group(
    store: Store,
    runId: string,
    groupId: string,
    limit: number,
    guard?: NetworkGuard,
  ): Promise<GroupVerifyResult>;
}

const defaultVerifier: Verifier = {
  issues: (store, runId, ids, guard) =>
    verifyAndSave(store, runId, ids, { pageTimeoutMs: 20_000, guard }),
  group: (store, runId, groupId, limit, guard) =>
    verifyGroupAndSave(store, runId, groupId, limit, { pageTimeoutMs: 20_000, guard }),
};

/** What a visitor of a public server may do. Everything has a safe default. */
export interface PublicLimits {
  /** Pages per scan (the UI offers up to this; the server clamps to it). */
  maxPages: number;
  maxDepth: number;
  maxExternalLinks: number;
  /** Time budget of one scan. */
  scanTimeoutMs: number;
  /** Bytes the scan's browser may download in total. */
  maxBytesPerScan: number;
  /** Scans waiting or running for one visitor. */
  activeScansPerOwner: number;
  scansPerOwnerPerDay: number;
  scansPerIpPerHour: number;
  verifiesPerOwnerPerHour: number;
  sessionsPerIpPerHour: number;
  requestsPerIpPerMinute: number;
  /** Scans allowed to wait behind the running one (all visitors together). */
  maxQueued: number;
  /** Runs (and their files) are deleted this many hours after they started. */
  retentionHours: number;
}

export const DEFAULT_PUBLIC_LIMITS: PublicLimits = {
  maxPages: 20,
  maxDepth: 2,
  maxExternalLinks: 30,
  scanTimeoutMs: 5 * 60_000,
  maxBytesPerScan: 250 * 1024 * 1024,
  activeScansPerOwner: 1,
  scansPerOwnerPerDay: 10,
  scansPerIpPerHour: 15,
  verifiesPerOwnerPerHour: 60,
  sessionsPerIpPerHour: 30,
  requestsPerIpPerMinute: 900,
  maxQueued: 5,
  retentionHours: 24,
};

export interface PublicModeOptions {
  /** Signs session tokens. Random per start when omitted (sessions end on restart). */
  secret?: string;
  /** Exact origins that may be scanned although they are private (the operator's own demo). */
  allowOrigins?: string[];
  /** Host names this server answers to; any Host is accepted when omitted. */
  allowedHosts?: string[];
  /** Trust X-Forwarded-For (only behind a reverse proxy you control). */
  trustProxy?: boolean;
  /** Addresses offered as one-click examples. */
  examples?: string[];
  limits?: Partial<PublicLimits>;
  /** Test seam: builds the network guard for one scan or verification. */
  createGuard?: typeof createNetworkGuard;
}

const DISCLAIMER =
  "Only scan sites you own or have permission to test. Scans are limited, results are deleted automatically, and nothing here is a security audit.";

/** Verifications are heavy (a real browser): run one at a time and refuse a long backlog. */
const MAX_PENDING_VERIFICATIONS = 3;

export interface ApiOptions {
  /** Directory with `webdoctor.db` and `runs/` (the CLI's `--out`). */
  dataDir: string;
  /** Required on every `/api/*` request in local mode (header `x-webdoctor-token` or `?token=`). */
  token?: string;
  /** Public mode: anonymous sessions, a network guard on every request and per-visitor limits. */
  public?: PublicModeOptions;
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
  const pub = options.public;
  if (!pub && !options.token) throw new Error("A non-empty token is required");
  const limits: PublicLimits = { ...DEFAULT_PUBLIC_LIMITS, ...pub?.limits };
  const dataDir = resolve(options.dataDir);
  const store = openStore(join(dataDir, "webdoctor.db"));
  const expected = digest(options.token ?? "");

  // ---- public mode state ----
  const sessions = new SessionTokens(Buffer.from(pub?.secret ?? randomBytes(32).toString("hex")));
  const policy = createPolicy({ allowOrigins: pub?.allowOrigins ?? [] });
  const buildGuard = pub?.createGuard ?? createNetworkGuard;
  const newGuard = () =>
    buildGuard({
      policy: { allowOrigins: pub?.allowOrigins ?? [] },
      maxBytes: limits.maxBytesPerScan,
    });
  const perMinute = new RateLimiter(limits.requestsPerIpPerMinute, 60_000);
  const sessionsPerIp = new RateLimiter(limits.sessionsPerIpPerHour, 3_600_000);
  const scansPerIp = new RateLimiter(limits.scansPerIpPerHour, 3_600_000);
  const scansPerOwner = new RateLimiter(limits.scansPerOwnerPerDay, 24 * 3_600_000);
  const verifiesPerOwner = new RateLimiter(limits.verifiesPerOwnerPerHour, 3_600_000);
  const owners = new WeakMap<FastifyRequest, string>();
  const ownerOf = (req: FastifyRequest): string | undefined => owners.get(req);
  const tooMany = (reply: FastifyReply, limiter: RateLimiter, key: string, message: string) =>
    reply
      .code(429)
      .header("retry-after", String(Math.max(1, limiter.retryAfter(key))))
      .send({ error: message });
  /** Runs a visitor may see: all of them locally, only their own in public mode. */
  const mayAccess = (req: FastifyRequest, runId: string): boolean =>
    !pub || store.getRunOwner(runId) === ownerOf(req);

  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: pub?.trustProxy ?? false,
    bodyLimit: pub ? 16 * 1024 : undefined,
  });
  app.addHook("onClose", async () => store.close());

  if (pub) {
    const sweep = () => {
      const cutoff = new Date(Date.now() - limits.retentionHours * 3_600_000).toISOString();
      try {
        sweepRetention(store, dataDir, cutoff);
      } catch (error) {
        app.log.error(error);
      }
    };
    sweep();
    const timer = setInterval(sweep, 10 * 60_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  const OPEN_PATHS = new Set(["/api/health", "/api/config"]);

  app.addHook("onRequest", async (req, reply) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (pub) {
      // the container health check calls /api/health by address, not by public name
      const healthCheck = req.url === "/api/health";
      if (pub.allowedHosts?.length && !healthCheck && !pub.allowedHosts.includes(hostname)) {
        return reply.code(403).send({ error: "forbidden host" });
      }
    } else if (!ALLOWED_HOSTS.has(hostname)) {
      return reply.code(403).send({ error: "forbidden host" });
    }
    if (!req.url.startsWith("/api/")) return;
    const path = req.url.split("?")[0]!;

    if (pub) {
      if (!perMinute.take(req.ip)) {
        return tooMany(reply, perMinute, req.ip, "Too many requests. Slow down a little.");
      }
      if (OPEN_PATHS.has(path) || path === "/api/session") return;
      const query = req.query as { token?: string } | undefined;
      const owner = sessions.verify(req.headers["x-webdoctor-token"] ?? query?.token);
      if (!owner) return reply.code(401).send({ error: "missing or invalid session" });
      owners.set(req, owner);
      return;
    }

    if (path === "/api/health") return;
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

  app.get("/api/health", async () => ({ ok: true, mode: pub ? "public" : "local" }));

  app.get("/api/config", async () =>
    pub
      ? {
          mode: "public",
          limits: {
            maxPages: limits.maxPages,
            maxDepth: limits.maxDepth,
            scansPerDay: limits.scansPerOwnerPerDay,
            retentionHours: limits.retentionHours,
          },
          examples: pub.examples ?? [],
          disclaimer: DISCLAIMER,
        }
      : { mode: "local" },
  );

  if (pub) {
    app.post("/api/session", async (req, reply) => {
      if (!sessionsPerIp.take(req.ip)) {
        return tooMany(reply, sessionsPerIp, req.ip, "Too many sessions from this address.");
      }
      return reply.code(201).send({ token: sessions.issue() });
    });
  }

  app.get("/api/runs", async (req) => store.listRuns(pub ? { owner: ownerOf(req)! } : undefined));

  app.get<{ Params: { id: string }; Querystring: { includeFixed?: string; maxFindings?: string } }>(
    "/api/runs/:id/fix-prompt.md",
    async (req, reply) => {
      if (!RUN_ID.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
      const report = mayAccess(req, req.params.id) ? store.getReport(req.params.id) : undefined;
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
    if (!mayAccess(req, req.params.id)) return reply.code(404).send({ error: "run not found" });
    return store.listVerifications(req.params.id);
  });

  // ---- Scans started from the UI (local mode: any http(s) address, including localhost) ----
  const scans = new ScanManager({
    dataDir,
    run: options.scanRunner,
    ...(pub
      ? {
          maxQueued: limits.maxQueued,
          timeoutMs: () => limits.scanTimeoutMs,
          prepare: async () => {
            const guard = await newGuard();
            return {
              extra: { guard, maxExternalLinks: limits.maxExternalLinks },
              dispose: () => guard.close(),
            };
          },
          describeError: (error: unknown) => {
            if (!(error instanceof GuardError)) app.log.error(error);
            return error instanceof GuardError ? error.message : "The scan could not be completed.";
          },
        }
      : {}),
  });

  app.post("/api/scans", async (req, reply) => {
    const parsed = StartScanSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid scan settings";
      return reply.code(400).send({ error: message });
    }
    let input = parsed.data;
    const owner = ownerOf(req);
    if (pub) {
      // refuse private targets right away, with a message the visitor can act on
      try {
        await checkUrl(input.url, policy);
      } catch (error) {
        if (error instanceof GuardError) return reply.code(400).send({ error: error.message });
        throw error;
      }
      if (scansPerOwner.retryAfter(owner!) > 0) {
        return tooMany(reply, scansPerOwner, owner!, "Daily scan limit reached for this session.");
      }
      if (scansPerIp.retryAfter(req.ip) > 0) {
        return tooMany(reply, scansPerIp, req.ip, "Too many scans from this address. Try later.");
      }
      if (scans.activeFor(owner) >= limits.activeScansPerOwner) {
        return reply.code(429).send({ error: "You already have a scan in progress." });
      }
      input = {
        ...input,
        maxPages: Math.min(input.maxPages, limits.maxPages),
        maxDepth: Math.min(input.maxDepth, limits.maxDepth),
        respectRobots: true,
      };
    }
    const job = scans.start(input, owner);
    if (job === "busy") {
      return reply
        .code(429)
        .send({ error: "Too many scans waiting. Try again when one has finished." });
    }
    if (pub) {
      scansPerOwner.take(owner!);
      scansPerIp.take(req.ip);
    }
    return reply.code(202).send(job);
  });

  app.get("/api/scans", async (req) => scans.list(ownerOf(req)));

  app.get<{ Params: { id: string } }>("/api/scans/:id", async (req, reply) => {
    const job = scans.get(req.params.id, ownerOf(req));
    return job ?? reply.code(404).send({ error: "scan not found" });
  });

  app.post<{ Params: { id: string } }>("/api/scans/:id/cancel", async (req, reply) => {
    const job = scans.cancel(req.params.id, ownerOf(req));
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

  /** Public mode: every verification gets its own guard (browser proxy + guarded fetch). */
  const withGuard = async <T>(fn: (guard?: NetworkGuard) => Promise<T>): Promise<T> => {
    if (!pub) return fn();
    const guard = await newGuard();
    try {
      return await fn(guard);
    } finally {
      await guard.close();
    }
  };

  const respond = async <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    runId: string,
    job: (guard?: NetworkGuard) => Promise<T>,
  ): Promise<unknown> => {
    if (!mayAccess(req, runId)) return reply.code(404).send({ error: "run not found" });
    if (pub) {
      const owner = ownerOf(req)!;
      if (verifiesPerOwner.retryAfter(owner) > 0) {
        return tooMany(reply, verifiesPerOwner, owner, "Too many re-checks. Try again later.");
      }
      verifiesPerOwner.take(owner);
    }
    try {
      const result = await enqueue(() => withGuard(job));
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
      return respond(req, reply, id, (guard) => verifier.issues(store, id, [issueId], guard));
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
      return respond(req, reply, id, (guard) => verifier.group(store, id, groupId, limit, guard));
    },
  );

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    if (!RUN_ID.test(req.params.id)) return reply.code(400).send({ error: "bad run id" });
    const report = mayAccess(req, req.params.id) ? store.getReport(req.params.id) : undefined;
    if (!report) return reply.code(404).send({ error: "run not found" });
    return report;
  });

  app.get<{ Params: { id: string; "*": string } }>(
    "/api/runs/:id/artifacts/*",
    async (req, reply) => {
      const { id } = req.params;
      const key = req.params["*"];
      if (!RUN_ID.test(id)) return reply.code(400).send({ error: "bad run id" });
      if (!mayAccess(req, id)) return reply.code(404).send({ error: "artifact not found" });

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
