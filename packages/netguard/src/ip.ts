import { isIPv4, isIPv6 } from "node:net";

/**
 * Which IP addresses may a public scan talk to? Only globally routable unicast addresses.
 * Everything that is loopback, private, link-local (cloud metadata lives at 169.254.169.254),
 * shared/CGNAT, multicast, reserved or documentation space is refused, in IPv4 and IPv6,
 * including IPv6 forms that merely wrap an IPv4 address (::ffff:127.0.0.1, NAT64, 6to4).
 */

export type AddressClass = "public" | "private";

export interface Classification {
  class: AddressClass;
  /** Why it is not public, for the log and for tests. */
  category?: string;
}

const PUBLIC: Classification = { class: "public" };
const blocked = (category: string): Classification => ({ class: "private", category });

// ---- IPv4 -----------------------------------------------------------------------------------

/** "a.b.c.d" -> unsigned 32-bit number, or null when it is not a strict dotted quad. */
export function parseIPv4(ip: string): number | null {
  if (!isIPv4(ip)) return null; // strict: no octal/hex/short forms (URL parsing normalizes those)
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const V4_BLOCKS: [string, number, string][] = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared-address-space"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local/metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-protocol"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4-relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function inV4(n: number, base: string, prefix: number): boolean {
  const b = parseIPv4(base)!;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
}

export function classifyIPv4(ip: string): Classification {
  const n = parseIPv4(ip);
  if (n === null) return blocked("invalid");
  for (const [base, prefix, category] of V4_BLOCKS) {
    if (inV4(n, base, prefix)) return blocked(category);
  }
  return PUBLIC;
}

// ---- IPv6 -----------------------------------------------------------------------------------

/** Eight 16-bit groups, or null. Handles "::" and an embedded dotted IPv4 tail. */
export function parseIPv6(ip: string): number[] | null {
  if (!isIPv6(ip) || ip.includes("%")) return null; // zone ids are never acceptable
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!);
    if (v4 === null) return null;
    text =
      text.slice(0, -dotted[1]!.length) +
      `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = "", tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = tail === undefined ? left : [...left, ...Array(missing).fill("0"), ...right];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff)
    ? nums
    : null;
}

const embeddedV4 = (hi: number, lo: number): string =>
  `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

export function classifyIPv6(ip: string): Classification {
  const g = parseIPv6(ip);
  if (!g) return blocked("invalid");
  const [a, b, c, d, e, f, x, y] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  if (g.every((v) => v === 0)) return blocked("unspecified");
  if (g.slice(0, 7).every((v) => v === 0) && y === 1) return blocked("loopback");

  // IPv4-mapped (::ffff:a.b.c.d): the answer is the embedded address' answer
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return classifyIPv4(embeddedV4(x, y));
  }
  // deprecated IPv4-compatible (::a.b.c.d) and anything else in ::/96
  if (g.slice(0, 6).every((v) => v === 0)) return blocked("ipv4-compatible");

  // NAT64 well-known prefix 64:ff9b::/96 wraps an IPv4 address; the local-use prefix is private
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0) return classifyIPv4(embeddedV4(x, y));
    if (c === 1) return blocked("nat64-local");
  }
  // 6to4 (2002::/16) embeds the IPv4 address in bits 16..47
  if (a === 0x2002) return classifyIPv4(embeddedV4(b, c));

  if ((a & 0xffc0) === 0xfe80) return blocked("link-local");
  if ((a & 0xffc0) === 0xfec0) return blocked("site-local");
  if ((a & 0xfe00) === 0xfc00) return blocked("unique-local");
  if ((a & 0xff00) === 0xff00) return blocked("multicast");
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return blocked("discard");
  if (a === 0x2001 && b === 0) return blocked("teredo");
  if (a === 0x2001 && (b & 0xfff0) === 0x10) return blocked("orchid");
  if (a === 0x2001 && b === 0xdb8) return blocked("documentation");
  if (a === 0x3fff && (b & 0xf000) === 0) return blocked("documentation");
  if (a === 0x5f00) return blocked("srv6");

  // only global unicast 2000::/3 is public; everything else is not assigned for the open internet
  return (a & 0xe000) === 0x2000 ? PUBLIC : blocked("not-global-unicast");
}

/** Public or not, for any IP literal. Anything that is not an IP literal is "private". */
export function classifyIp(ip: string): Classification {
  if (isIPv4(ip)) return classifyIPv4(ip);
  if (isIPv6(ip)) return classifyIPv6(ip);
  return blocked("not-an-ip");
}

export const isPublicIp = (ip: string): boolean => classifyIp(ip).class === "public";
