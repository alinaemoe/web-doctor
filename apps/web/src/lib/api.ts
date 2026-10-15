import { ReportSchema } from "@webdoctor/core/shared";
import type { Report } from "@webdoctor/core/shared";

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
