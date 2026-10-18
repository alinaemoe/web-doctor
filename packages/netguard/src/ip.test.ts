import { describe, expect, it } from "vitest";
import { classifyIp, classifyIPv4, classifyIPv6, isPublicIp, parseIPv4, parseIPv6 } from "./ip";

const PUBLIC_V4 = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "142.250.74.14",
  "172.32.0.1",
  "11.0.0.1",
  "100.63.255.255",
  "100.128.0.0",
];
const PUBLIC_V6 = [
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001:81b::200e",
  "2400:cb00::1",
];

const PRIVATE_V4: [string, string][] = [
  ["0.0.0.0", "this-network"],
  ["0.1.2.3", "this-network"],
  ["10.0.0.1", "private"],
  ["10.255.255.255", "private"],
  ["100.64.0.1", "shared-address-space"],
  ["100.127.255.255", "shared-address-space"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["169.254.169.254", "link-local/metadata"],
  ["169.254.0.1", "link-local/metadata"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.0.0.8", "ietf-protocol"],
  ["192.0.2.1", "documentation"],
  ["192.168.0.1", "private"],
  ["192.168.255.255", "private"],
  ["198.18.0.1", "benchmarking"],
  ["198.19.255.255", "benchmarking"],
  ["198.51.100.7", "documentation"],
  ["203.0.113.9", "documentation"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "reserved"],
];

const PRIVATE_V6: [string, string][] = [
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["::ffff:127.0.0.1", "loopback"],
  ["::ffff:7f00:1", "loopback"],
  ["::ffff:10.1.2.3", "private"],
  ["::ffff:169.254.169.254", "link-local/metadata"],
  ["::ffff:a9fe:a9fe", "link-local/metadata"],
  ["::127.0.0.1", "ipv4-compatible"],
  ["64:ff9b::7f00:1", "loopback"],
  ["64:ff9b::a9fe:a9fe", "link-local/metadata"],
  ["64:ff9b:1::1", "nat64-local"],
  ["2002:7f00:1::1", "loopback"],
  ["2002:a00:1::", "private"],
  ["2002:c0a8:101::", "private"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local"],
  ["fec0::1", "site-local"],
  ["fc00::1", "unique-local"],
  ["fd12:3456:789a::1", "unique-local"],
  ["ff02::1", "multicast"],
  ["100::1", "discard"],
  ["2001::1", "teredo"],
  ["2001:db8::1", "documentation"],
  ["2001:10::1", "orchid"],
  ["3fff::1", "documentation"],
  ["5f00::1", "srv6"],
  ["1::1", "not-global-unicast"],
];

describe("IPv4", () => {
  it.each(PUBLIC_V4)("%s is public", (ip) => {
    expect(classifyIPv4(ip)).toEqual({ class: "public" });
  });

  it.each(PRIVATE_V4)("%s is not public (%s)", (ip, category) => {
    expect(classifyIPv4(ip)).toEqual({ class: "private", category });
  });

  it("only accepts strict dotted quads (odd forms are normalized before they get here)", () => {
    expect(parseIPv4("127.0.0.1")).toBe(0x7f000001);
    for (const odd of [
      "127.1",
      "0x7f.0.0.1",
      "2130706433",
      "017700000001",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "",
    ]) {
      expect(parseIPv4(odd), odd).toBeNull();
    }
    expect(classifyIPv4("127.1").class).toBe("private"); // unparseable is never "public"
  });
});

describe("IPv6", () => {
  it.each(PUBLIC_V6)("%s is public", (ip) => {
    expect(classifyIPv6(ip)).toEqual({ class: "public" });
  });

  it.each(PRIVATE_V6)("%s is not public (%s)", (ip, category) => {
    expect(classifyIPv6(ip)).toEqual({ class: "private", category });
  });

  it("looks through wrappers around a public IPv4 address", () => {
    expect(classifyIPv6("::ffff:8.8.8.8").class).toBe("public");
    expect(classifyIPv6("64:ff9b::808:808").class).toBe("public");
    expect(classifyIPv6("2002:808:808::1").class).toBe("public");
  });

  it("parses compressed, embedded-IPv4 and full forms alike", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1::8")).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6("0000:0000:0000:0000:0000:0000:0000:0001")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("refuses zone ids and malformed text", () => {
    for (const bad of [
      "fe80::1%eth0",
      "::1::2",
      "12345::1",
      "g::1",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "",
    ]) {
      expect(parseIPv6(bad), bad).toBeNull();
    }
    expect(classifyIPv6("fe80::1%eth0").class).toBe("private");
  });
});

describe("classifyIp", () => {
  it("dispatches by family and never calls a non-IP public", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("example.com")).toBe(false);
    expect(isPublicIp("")).toBe(false);
    expect(classifyIp("not-an-ip")).toEqual({ class: "private", category: "not-an-ip" });
  });

  it("range edges: the block starts and ends exactly where it should", () => {
    expect(isPublicIp("172.15.255.255")).toBe(true);
    expect(isPublicIp("172.16.0.0")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
    expect(isPublicIp("172.32.0.0")).toBe(true);
    expect(isPublicIp("100.63.255.255")).toBe(true);
    expect(isPublicIp("100.64.0.0")).toBe(false);
    expect(isPublicIp("100.127.255.255")).toBe(false);
    expect(isPublicIp("100.128.0.0")).toBe(true);
    expect(isPublicIp("169.253.255.255")).toBe(true);
    expect(isPublicIp("169.254.0.0")).toBe(false);
    expect(isPublicIp("198.17.255.255")).toBe(true);
    expect(isPublicIp("198.20.0.0")).toBe(true);
  });
});
