import { IssueSchema, ReportSchema, VerificationSchema } from "@webdoctor/core/shared";
import type { Issue, Report, Verification } from "@webdoctor/core/shared";
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
