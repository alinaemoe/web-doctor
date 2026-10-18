import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyIp } from "./ip";

export type BlockReason =
  | "scheme"
  | "credentials"
  | "port"
  | "hostname"
  | "private-address"
  | "unresolvable"
  | "invalid-url";

/** Thrown (or reported) when an address is not allowed. `message` is safe to show to a user. */
export class GuardError extends Error {
  constructor(
    readonly reason: BlockReason,
    message: string,
    readonly host?: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

export interface GuardPolicy {
  /** Ports that may be contacted (default 80, 443, 8080, 8443). */
  allowedPorts: number[];
  /**
   * Origins (`http://127.0.0.1:4000`) that may be reached even though they are not public. For
   * the demo site that the operator hosts next to the scanner: configuration only, never user input.
   */
  allowOrigins: string[];
  /** DNS resolver (replaceable in tests). Must return every address of the name. */
  resolve: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_PORTS = [80, 443, 8080, 8443];

export function createPolicy(overrides: Partial<GuardPolicy> = {}): GuardPolicy {
  return {
    allowedPorts: overrides.allowedPorts ?? DEFAULT_PORTS,
    allowOrigins: (overrides.allowOrigins ?? []).map(normalizeOrigin),
    resolve:
      overrides.resolve ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address)),
  };
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** Names that can only mean "somewhere inside this network", whatever DNS says. */
const INTERNAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".home",
  ".home.arpa",
  ".private",
];

export function checkHostname(host: string): void {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name) throw new GuardError("hostname", "The address has no host name.", host);
  if (isIP(stripBrackets(name))) return; // an IP literal: judged by its address, not its name
  if (
    name === "localhost" ||
    INTERNAL_SUFFIXES.some((s) => name.endsWith(s)) ||
    !name.includes(".")
  ) {
    throw new GuardError(
      "hostname",
      "This address points to a private network and cannot be scanned here.",
      host,
    );
  }
}

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, "");

export interface Target {
  url: URL;
  hostname: string;
  port: number;
  origin: string;
  /** Allow-listed origin: skips the address check. */
  allowed: boolean;
}

/**
 * Everything that can be decided without the network: scheme, credentials, port, host name, and
 * the address when the host is an IP literal. (The URL parser has already turned forms like
 * 2130706433, 0x7f.1 or 017700000001 into dotted decimal, so they are judged as 127.0.0.1.)
 */
export function checkStatic(raw: string | URL, policy: GuardPolicy): Target {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new GuardError("invalid-url", "That is not a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GuardError("scheme", "Only http and https addresses can be scanned.");
  }
  if (url.username || url.password) {
    throw new GuardError("credentials", "Addresses with a user name or password are not allowed.");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const hostname = stripBrackets(url.hostname);
  const allowed = policy.allowOrigins.includes(url.origin);

  if (!allowed) {
    if (!policy.allowedPorts.includes(port)) {
      throw new GuardError(
        "port",
        `Port ${port} is not allowed. Allowed ports: ${policy.allowedPorts.join(", ")}.`,
        hostname,
      );
    }
    checkHostname(hostname);
    if (isIP(hostname) && classifyIp(hostname).class !== "public") {
      throw new GuardError(
        "private-address",
        "This address points to a private network and cannot be scanned here.",
        hostname,
      );
    }
  }
  return { url, hostname, port, origin: url.origin, allowed };
}

export interface Resolved {
  address: string;
  family: 4 | 6;
}

/**
 * The address to connect to for a host name. EVERY address the name resolves to must be public:
 * a name with one public and one private answer is refused, so an attacker cannot hide behind
 * round-robin DNS. The caller must connect to the returned address (pinning), never resolve again.
 */
export async function resolvePublic(
  hostname: string,
  policy: GuardPolicy,
  allowed = false,
): Promise<Resolved> {
  const ip = isIP(stripBrackets(hostname));
  const addresses = ip ? [stripBrackets(hostname)] : await resolveAll(hostname, policy);
  if (addresses.length === 0) {
    throw new GuardError("unresolvable", "The host name could not be resolved.", hostname);
  }
  if (!allowed) {
    for (const address of addresses) {
      if (classifyIp(address).class !== "public") {
        throw new GuardError(
          "private-address",
          "This address points to a private network and cannot be scanned here.",
          hostname,
        );
      }
    }
  }
  const first = addresses[0]!;
  return { address: first, family: isIP(first) === 6 ? 6 : 4 };
}

async function resolveAll(hostname: string, policy: GuardPolicy): Promise<string[]> {
  try {
    return await policy.resolve(hostname);
  } catch {
    throw new GuardError("unresolvable", "The host name could not be resolved.", hostname);
  }
}

/** Static checks plus DNS: a complete pre-flight check for a start URL. */
export async function checkUrl(raw: string | URL, policy: GuardPolicy): Promise<Target> {
  const target = checkStatic(raw, policy);
  await resolvePublic(target.hostname, policy, target.allowed);
  return target;
}
