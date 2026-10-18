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

async function get(path: string): Promise<unknown> {
  const res = await fetch(path, { headers: { "x-webdoctor-token": token ?? "" } });
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
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "x-webdoctor-token": token ?? "",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/fix-prompt.md`, {
    headers: { "x-webdoctor-token": token ?? "" },
  });
  if (!res.ok) throw new ApiError(`Could not create the fix prompt (${res.status})`, res.status);
  return res.text();
}
