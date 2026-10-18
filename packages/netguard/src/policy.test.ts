import { describe, expect, it } from "vitest";
import { GuardError, checkStatic, checkUrl, createPolicy, resolvePublic } from "./policy";

const policy = createPolicy({ resolve: async () => ["93.184.216.34"] });
const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof GuardError ? e.reason : `other:${String(e)}`;
  }
  return undefined;
};

describe("checkStatic", () => {
  it("accepts ordinary public web addresses", () => {
    for (const url of [
      "https://example.com/",
      "http://example.com/path?q=1",
      "https://www.praguecoolpass.com/en",
      "http://example.com:8080/",
      "https://example.com:8443/x",
      "http://93.184.216.34/",
      "https://[2606:4700:4700::1111]/",
      "https://xn--e1afmkfd.xn--p1ai/", // punycode host
    ]) {
      expect(
        reason(() => checkStatic(url, policy)),
        url,
      ).toBeUndefined();
    }
  });

  it("refuses everything that is not http(s)", () => {
    for (const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "gopher://x.test/",
      "ws://example.com/",
    ]) {
      expect(
        reason(() => checkStatic(url, policy)),
        url,
      ).toBe("scheme");
    }
  });

  it("refuses text that is not an address", () => {
    for (const url of ["", "example.com", "not a url", "http://", "//example.com"]) {
      expect(
        reason(() => checkStatic(url, policy)),
        url,
      ).toBe("invalid-url");
    }
  });

  it("refuses credentials in the address", () => {
    expect(reason(() => checkStatic("https://user:pw@example.com/", policy))).toBe("credentials");
    expect(reason(() => checkStatic("https://user@example.com/", policy))).toBe("credentials");
  });

  it("refuses ports other than the allowed ones", () => {
    for (const port of [22, 25, 3306, 5432, 6379, 8081, 9200, 27017, 11211]) {
      expect(
        reason(() => checkStatic(`http://example.com:${port}/`, policy)),
        String(port),
      ).toBe("port");
    }
    expect(reason(() => checkStatic("http://example.com:80/", policy))).toBeUndefined();
    expect(reason(() => checkStatic("https://example.com:443/", policy))).toBeUndefined();
  });

  it("judges IP literals by their address, in every spelling the URL parser understands", () => {
    const loopbackForms = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0x7f000001/",
      "http://017700000001/",
      "http://0177.0.0.1/",
      "http://127.0.0.1.:80/",
      "http://[::1]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://0/",
      "http://0.0.0.0/",
    ];
    for (const url of loopbackForms)
      expect(
        reason(() => checkStatic(url, policy)),
        url,
      ).toBe("private-address");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:169.254.169.254]/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://100.64.0.1/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
    ]) {
      expect(
        reason(() => checkStatic(url, policy)),
        url,
      ).toBe("private-address");
    }
  });

  it("refuses host names that can only mean an internal network", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "app.localhost",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "nas.lan",
      "wiki.corp",
      "intranet",
      "router",
      "x.home.arpa",
      "svc.localdomain",
    ]) {
      expect(
        reason(() => checkStatic(`http://${host}/`, policy)),
        host,
      ).toBe("hostname");
    }
  });

  it("lets an allow-listed origin through: ports, names and private addresses", () => {
    const withDemo = createPolicy({
      allowOrigins: ["http://127.0.0.1:4000", "http://localhost:4001"],
    });
    expect(checkStatic("http://127.0.0.1:4000/products", withDemo).allowed).toBe(true);
    expect(checkStatic("http://localhost:4001/limited", withDemo).allowed).toBe(true);
    // the exception is exact: same host on another port, or another loopback address, is not covered
    expect(reason(() => checkStatic("http://127.0.0.1:4002/", withDemo))).toBe("port");
    expect(reason(() => checkStatic("http://127.0.0.1:80/", withDemo))).toBe("private-address");
    expect(reason(() => checkStatic("http://127.0.0.2:4000/", withDemo))).toBe("port");
    expect(reason(() => checkStatic("https://127.0.0.1:4000/", withDemo))).toBe("port");
  });

  it("gives messages that are safe and understandable for a user", () => {
    try {
      checkStatic("http://169.254.169.254/", policy);
    } catch (e) {
      expect((e as GuardError).message).toBe(
        "This address points to a private network and cannot be scanned here.",
      );
      expect((e as GuardError).message).not.toContain("169.254");
    }
  });
});

describe("resolvePublic", () => {
  it("returns the first address when every address is public", async () => {
    const p = createPolicy({
      resolve: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    });
    expect(await resolvePublic("example.com", p)).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a name with ANY private address (round-robin tricks)", async () => {
    const mixed = createPolicy({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
    await expect(resolvePublic("evil.example.com", mixed)).rejects.toMatchObject({
      reason: "private-address",
    });
    const mixedV6 = createPolicy({ resolve: async () => ["2606:4700:4700::1111", "::1"] });
    await expect(resolvePublic("evil.example.com", mixedV6)).rejects.toMatchObject({
      reason: "private-address",
    });
  });

  it("refuses names that point at private space, including IPv4 hidden in IPv6", async () => {
    for (const address of [
      "10.0.0.1",
      "169.254.169.254",
      "::ffff:192.168.0.1",
      "fd00::1",
      "127.0.0.1",
    ]) {
      const p = createPolicy({ resolve: async () => [address] });
      await expect(resolvePublic("x.example.com", p), address).rejects.toMatchObject({
        reason: "private-address",
      });
    }
  });

  it("reports unresolvable names and resolver failures", async () => {
    await expect(
      resolvePublic("nope.example.com", createPolicy({ resolve: async () => [] })),
    ).rejects.toMatchObject({ reason: "unresolvable" });
    await expect(
      resolvePublic(
        "nope.example.com",
        createPolicy({ resolve: async () => Promise.reject(new Error("ENOTFOUND")) }),
      ),
    ).rejects.toMatchObject({ reason: "unresolvable" });
  });

  it("resolves once and returns exactly what it checked (pinning, no second lookup)", async () => {
    // a rebinding server: public on the first answer, loopback afterwards
    let calls = 0;
    const p = createPolicy({
      resolve: async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });
    const resolved = await resolvePublic("rebind.example.com", p);
    expect(resolved.address).toBe("93.184.216.34");
    expect(calls).toBe(1); // the connection must use `resolved.address`; nobody asks DNS again
  });

  it("judges an IP literal without DNS and honors the allow flag", async () => {
    let calls = 0;
    const p = createPolicy({ resolve: async () => (calls++, ["8.8.8.8"]) });
    await expect(resolvePublic("127.0.0.1", p)).rejects.toMatchObject({
      reason: "private-address",
    });
    await expect(resolvePublic("[::1]", p)).rejects.toMatchObject({ reason: "private-address" });
    expect(await resolvePublic("127.0.0.1", p, true)).toEqual({ address: "127.0.0.1", family: 4 });
    expect(calls).toBe(0);
  });
});

describe("checkUrl", () => {
  it("is the full pre-flight: static rules first, then DNS", async () => {
    await expect(checkUrl("https://example.com/", policy)).resolves.toMatchObject({
      hostname: "example.com",
    });
    await expect(checkUrl("ftp://example.com/", policy)).rejects.toMatchObject({
      reason: "scheme",
    });
    const toPrivate = createPolicy({ resolve: async () => ["10.0.0.9"] });
    await expect(checkUrl("https://looks-public.example.com/", toPrivate)).rejects.toMatchObject({
      reason: "private-address",
    });
  });
});
