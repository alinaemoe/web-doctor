import { IssueSchema, ReportSchema, VerificationSchema } from "@webdoctor/core/shared";
import type { Issue, Report, RunSummary, Verification } from "@webdoctor/core/shared";
import { z } from "zod";

const STORAGE_KEY = "webdoctor.token";

export interface RunListItem {
  id: string;
  startUrl: string;
  status: string;
  startedAt: string;
  partial: boolean;
  failCount: number;
  unverifiedCount: number;
  /** Origin of the scanned address: runs of one site form one history. */
  site: string;
  previousRunId?: string;
  reanalyzedFrom?: string;
  summary: RunSummary;
}

let token: string | null = null;
/** On a public server the token is an anonymous session the page creates for itself. */
let publicMode = false;
const SESSION_KEY = "webdoctor.session";

export interface AppConfig {
  mode: "local" | "public";
  limits?: { maxPages: number; maxDepth: number; scansPerDay: number; retentionHours: number };
  examples: string[];
  disclaimer?: string;
}

const AppConfigSchema = z.object({
  mode: z.enum(["local", "public"]),
  limits: z
    .object({
      maxPages: z.number(),
      maxDepth: z.number(),
      scansPerDay: z.number(),
      retentionHours: z.number(),
    })
    .optional(),
  examples: z.array(z.string()).default([]),
  disclaimer: z.string().optional(),
});

function persistentStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function createSession(): Promise<string> {
  const res = await fetch("/api/session", { method: "POST" });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => undefined);
    throw new ApiError(detail ?? `Could not start a session (${res.status})`, res.status);
  }
  const created = z.object({ token: z.string() }).parse(await res.json());
  token = created.token;
  persistentStorage()?.setItem(SESSION_KEY, created.token);
  return created.token;
}

/**
 * Finds out which kind of server this is. A local server needs the `?token=` from the link the CLI
 * printed; a public server gives every browser its own anonymous session.
 */
export async function loadApp(): Promise<{ config: AppConfig; authorized: boolean }> {
  let config: AppConfig = { mode: "local", examples: [] };
  try {
    const res = await fetch("/api/config");
    // a local server answers 401 here (no token yet): that is the local default
    if (res.ok) config = AppConfigSchema.parse(await res.json());
  } catch {
    // keep the local default
  }
  publicMode = config.mode === "public";
  if (!publicMode) return { config, authorized: initToken() !== null };
  token = persistentStorage()?.getItem(SESSION_KEY) ?? null;
  if (!token) await createSession();
  return { config, authorized: true };
}

function safeStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads `?token=` once, keeps it for the tab session, and removes it from the address bar. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    token = fromUrl;
    safeStorage()?.setItem(STORAGE_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } else {
    token = safeStorage()?.getItem(STORAGE_KEY) ?? null;
  }
  return token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A public session that the server no longer knows (it restarted) is replaced once. */
async function withSession(send: () => Promise<Response>): Promise<Response> {
  const res = await send();
  if (res.status === 401 && publicMode) {
    await createSession();
    return send();
  }
  return res;
}

async function get(path: string): Promise<unknown> {
  const res = await withSession(() =>
    fetch(path, { headers: { "x-webdoctor-token": token ?? "" } }),
  );
  if (!res.ok) {
    throw new ApiError(
      res.status === 401
        ? "Not authorized. Open the link printed by `webdoctor ui` (it contains the access token)."
        : `Request failed (${res.status})`,
      res.status,
    );
  }
  return res.json();
}

export async function fetchRuns(): Promise<RunListItem[]> {
  return (await get("/api/runs")) as RunListItem[];
}

export async function fetchReport(runId: string): Promise<Report> {
  return ReportSchema.parse(await get(`/api/runs/${encodeURIComponent(runId)}`));
}

/** `<img>` cannot send headers, so screenshots carry the token in the query string. */
export function artifactUrl(runId: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${path}?token=${encodeURIComponent(token ?? "")}`;
}

async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await withSession(() =>
    fetch(path, {
      method: "POST",
      headers: {
        "x-webdoctor-token": token ?? "",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => undefined);
    throw new ApiError(detail ?? `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export async function fetchVerifications(runId: string): Promise<Verification[]> {
  return z
    .array(VerificationSchema)
    .parse(await get(`/api/runs/${encodeURIComponent(runId)}/verifications`));
}

export interface VerifyResponse {
  results: Verification[];
  issues: Issue[];
  checkedPages?: number;
  totalPages?: number;
}

const VerifyResponseSchema = z.object({
  results: z.array(VerificationSchema),
  issues: z.array(IssueSchema),
  checkedPages: z.number().optional(),
  totalPages: z.number().optional(),
});

export async function verifyIssue(runId: string, issueId: string): Promise<VerifyResponse> {
  return VerifyResponseSchema.parse(
    await post(
      `/api/runs/${encodeURIComponent(runId)}/issues/${encodeURIComponent(issueId)}/verify`,
    ),
  );
}

export async function verifyGroup(runId: string, groupId: string): Promise<VerifyResponse> {
  return VerifyResponseSchema.parse(
    await post(
      `/api/runs/${encodeURIComponent(runId)}/groups/${encodeURIComponent(groupId)}/verify`,
      {
        limit: 5,
      },
    ),
  );
}

export const ScanJobSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  phase: z.enum(["queued", "crawling", "checking-links", "saving", "done"]),
  pagesDone: z.number(),
  skipped: z.number(),
  lastUrl: z.string().optional(),
  recent: z.array(z.string()).default([]),
  queued: z.number().default(0),
  startedAt: z.string().optional(),
  linkTargets: z.number().optional(),
  runId: z.string().optional(),
  partial: z.boolean().optional(),
  failCount: z.number().optional(),
  error: z.string().optional(),
});
export type ScanJob = z.infer<typeof ScanJobSchema>;

export interface StartScanInput {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  viewports?: ("desktop" | "mobile")[];
  respectRobots?: boolean;
}

export interface ScanClient {
  start: (input: StartScanInput) => Promise<ScanJob>;
  get: (id: string) => Promise<ScanJob>;
  cancel: (id: string) => Promise<ScanJob>;
}

export const scanClient: ScanClient = {
  start: async (input) => ScanJobSchema.parse(await post("/api/scans", input)),
  get: async (id) => ScanJobSchema.parse(await get(`/api/scans/${encodeURIComponent(id)}`)),
  cancel: async (id) =>
    ScanJobSchema.parse(await post(`/api/scans/${encodeURIComponent(id)}/cancel`)),
};

/** The Markdown task for an AI coding agent (the body is plain text, not JSON). */
export async function fetchFixPrompt(runId: string): Promise<string> {
  const res = await withSession(() =>
    fetch(`/api/runs/${encodeURIComponent(runId)}/fix-prompt.md`, {
      headers: { "x-webdoctor-token": token ?? "" },
    }),
  );
  if (!res.ok) throw new ApiError(`Could not create the fix prompt (${res.status})`, res.status);
  return res.text();
}
