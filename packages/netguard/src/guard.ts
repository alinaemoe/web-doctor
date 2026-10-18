import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { createPolicy, checkStatic, checkUrl, resolvePublic } from "./policy";
import type { GuardPolicy } from "./policy";
import { startGuardProxy } from "./proxy";
import type { BlockedRecord } from "./proxy";

export type GuardedFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: "manual" | "follow" | "error";
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** What the rest of the program needs to keep a scan away from private networks. */
export interface NetworkGuard {
  policy: GuardPolicy;
  /** Pre-flight check of a start address (static rules + DNS). Throws GuardError. */
  checkUrl(url: string): Promise<void>;
  /**
   * fetch() for public addresses only. Each call is checked statically (scheme, port, IP literal);
   * host names are resolved and checked inside the connection itself, so the checked address is the
   * one that is connected to. Redirects must be followed by the caller, hop by hop.
   */
  fetch: GuardedFetch;
  /** Launch options that force a Chromium through the guard proxy and shut its side doors. */
  browser: { proxy: { server: string }; args: string[] };
  stats(): { bytes: number; blocked: BlockedRecord[]; budgetExceeded: boolean };
  close(): Promise<void>;
}

export interface GuardOptions {
  policy?: Partial<GuardPolicy>;
  maxBytes?: number;
}

export async function createNetworkGuard(options: GuardOptions = {}): Promise<NetworkGuard> {
  const policy = createPolicy(options.policy);
  const allowedHostnames = new Set(policy.allowOrigins.map((o) => safeHostname(o)));

  const agent = new Agent({
    connect: {
      // Runs for every new socket to a host NAME; the address it returns is the one connected to.
      lookup: ((hostname, lookupOptions, callback) => {
        resolvePublic(hostname, policy, allowedHostnames.has(hostname)).then(
          (r) =>
            lookupOptions.all
              ? callback(null, [{ address: r.address, family: r.family }])
              : callback(null, r.address, r.family),
          (error: Error) => callback(error, "", 4),
        );
      }) satisfies LookupFunction,
    },
  });

  const proxy = await startGuardProxy({ policy, maxBytes: options.maxBytes });

  const guardedFetch: GuardedFetch = async (url, init = {}) => {
    checkStatic(url, policy); // IP literals never reach the lookup above, so judge them here
    const response = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      redirect: init.redirect ?? "manual",
      dispatcher: agent,
    });
    return response as unknown as Response;
  };

  return {
    policy,
    checkUrl: async (url) => void (await checkUrl(url, policy)),
    fetch: guardedFetch,
    browser: {
      proxy: { server: proxy.url },
      args: [
        // loopback is proxied too (and refused there) instead of being reached directly
        "--proxy-bypass-list=<-loopback>",
        // Chromium must not resolve names itself: only the proxy decides where connections go
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        // side channels that would go around an HTTP proxy
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-networking",
      ],
    },
    stats: () => proxy.stats(),
    close: async () => {
      await proxy.close();
      await agent.close();
    },
  };
}

function safeHostname(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return origin;
  }
}
