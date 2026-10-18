import type { LinkCheck, LinkCheckError, RedirectHop } from "@webdoctor/core";
import { GuardError } from "@webdoctor/netguard";
import type { GuardedFetch } from "@webdoctor/netguard";

export interface LinkCheckOptions {
  timeoutMs?: number;
  maxHops?: number;
  userAgent?: string;
  /** Replaces the global fetch; in public mode this is the guarded fetch. */
  fetch?: GuardedFetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The guard's refusal, possibly wrapped by the HTTP client (`fetch failed` with a cause). */
function guardRefusal(error: unknown): GuardError | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    if (e instanceof GuardError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function classifyError(error: unknown): { error: LinkCheckError; errorText: string } {
  const refusal = guardRefusal(error);
  if (refusal) return { error: "blocked", errorText: refusal.message };
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  const code = err.cause?.code;
  const text = `${err.message ?? "request failed"}${code ? ` (${code})` : ""}`;
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return { error: "timeout", errorText: text };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { error: "dns", errorText: text };
  return { error: "network", errorText: text };
}

async function request(
  url: string,
  method: "HEAD" | "GET",
  opts: Required<LinkCheckOptions>,
): Promise<Response> {
  const res = await opts.fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs),
    headers: { "user-agent": opts.userAgent, accept: "*/*" },
  });
  // We only need the status; do not download bodies.
  void res.body?.cancel().catch(() => undefined);
  return res;
}

/**
 * Follows redirects manually (so the chain and loops are visible). Uses HEAD and falls back to GET
 * when the server rejects HEAD. Never throws: failures are reported in the result.
 */
export async function checkLink(url: string, options: LinkCheckOptions = {}): Promise<LinkCheck> {
  const opts: Required<LinkCheckOptions> = {
    timeoutMs: options.timeoutMs ?? 8000,
    maxHops: options.maxHops ?? 10,
    userAgent: options.userAgent ?? "WebDoctor/0.0 (+link-check)",
    fetch: options.fetch ?? (fetch as GuardedFetch),
  };

  const chain: RedirectHop[] = [];
  const seen = new Set<string>();
  let current = url;

  try {
    new URL(url);
  } catch {
    return { url, chain, loop: false, tooManyHops: false, error: "invalid", errorText: "bad URL" };
  }

  for (;;) {
    if (seen.has(current)) {
      return { url, finalUrl: current, chain, loop: true, tooManyHops: false };
    }
    seen.add(current);

    let res: Response;
    try {
      res = await request(current, "HEAD", opts);
      if (res.status === 405 || res.status === 501 || res.status === 403 || res.status === 404) {
        // Some servers answer HEAD differently from GET; trust GET.
        res = await request(current, "GET", opts);
      }
    } catch (error) {
      try {
        res = await request(current, "GET", opts);
      } catch (second) {
        return {
          url,
          finalUrl: current,
          chain,
          loop: false,
          tooManyHops: false,
          ...classifyError(second ?? error),
        };
      }
    }

    const location = res.headers.get("location");
    if (REDIRECT_STATUSES.has(res.status) && location) {
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return {
          url,
          finalUrl: current,
          status: res.status,
          chain,
          loop: false,
          tooManyHops: false,
        };
      }
      chain.push({ url: current, status: res.status, location: next });
      if (chain.length >= opts.maxHops) {
        return { url, finalUrl: next, chain, loop: false, tooManyHops: true };
      }
      current = next;
      continue;
    }

    return { url, finalUrl: current, status: res.status, chain, loop: false, tooManyHops: false };
  }
}

/** Checks many URLs with bounded concurrency; results are cached by the caller-provided map. */
export async function checkLinks(
  urls: Iterable<string>,
  cache: Map<string, LinkCheck>,
  options: LinkCheckOptions & { concurrency?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pending = [...new Set(urls)].filter((u) => !cache.has(u));
  let index = 0;
  const worker = async () => {
    while (index < pending.length && !options.signal?.aborted) {
      const url = pending[index++]!;
      cache.set(url, await checkLink(url, options));
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 5 }, worker));
}

/** Plain-text GET (robots.txt, sitemap.xml). Never throws. */
export async function fetchText(
  url: string,
  options: LinkCheckOptions = {},
): Promise<{ url: string; status?: number; text?: string; error?: LinkCheckError }> {
  const doFetch = options.fetch ?? (fetch as GuardedFetch);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8000);
  try {
    // redirects are followed here, one hop at a time, so each hop can be checked by the guard
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await doFetch(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": options.userAgent ?? "WebDoctor/0.0 (+fetch)" },
      });
      const location = res.headers.get("location");
      if (REDIRECT_STATUSES.has(res.status) && location) {
        void res.body?.cancel().catch(() => undefined);
        current = new URL(location, current).toString();
        continue;
      }
      const text = res.ok ? (await res.text()).slice(0, 2_000_000) : undefined;
      if (!res.ok) void res.body?.cancel().catch(() => undefined);
      return { url, status: res.status, text };
    }
    return { url, error: "network" };
  } catch (error) {
    return { url, error: classifyError(error).error };
  }
}
