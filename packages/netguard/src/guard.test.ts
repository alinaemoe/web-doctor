import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNetworkGuard } from "./guard";
import type { NetworkGuard } from "./guard";

let hits = 0;
let server: http.Server;
let port: number;
let guard: NetworkGuard;
let strict: NetworkGuard;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  guard = await createNetworkGuard({ policy: { allowOrigins: [`http://127.0.0.1:${port}`] } });
  strict = await createNetworkGuard({});
});
afterAll(async () => {
  await Promise.all([guard.close(), strict.close()]);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("guarded fetch", () => {
  it("reaches an allow-listed origin and returns redirects instead of following them", async () => {
    const res = await guard.fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("169.254.169.254");
    expect(hits).toBe(1);
  });

  it("refuses the next hop of that redirect (the metadata address)", async () => {
    await expect(guard.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      reason: "private-address",
    });
  });

  it("refuses internal targets before any connection", async () => {
    const before = hits;
    for (const url of [
      `http://127.0.0.1:${port}/`,
      "http://[::1]:80/",
      "http://2130706433/",
      "ftp://example.com/",
      "http://user:pw@example.com/",
      "http://example.com:22/",
    ]) {
      await expect(strict.fetch(url), url).rejects.toBeDefined();
    }
    expect(hits).toBe(before);
  });

  it("refuses internal-looking host names without needing DNS", async () => {
    await expect(strict.fetch("http://localhost:80/")).rejects.toMatchObject({
      reason: "hostname",
    });
    await expect(strict.fetch("http://db.internal/")).rejects.toMatchObject({ reason: "hostname" });
  });

  it("pre-flight check rejects private starts and passes public literals", async () => {
    await expect(strict.checkUrl("http://10.0.0.1/")).rejects.toMatchObject({
      reason: "private-address",
    });
    await expect(strict.checkUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});

describe("browser launch options", () => {
  it("forces everything through the proxy and closes the side doors", () => {
    expect(strict.browser.proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const args = strict.browser.args.join(" ");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("reports blocked destinations after use", async () => {
    expect(strict.stats().blocked).toEqual([]);
    const p = new URL(strict.browser.proxy.server);
    await new Promise<void>((resolve) => {
      http
        .request(
          { host: p.hostname, port: p.port, method: "GET", path: "http://10.1.1.1/x" },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        )
        .end();
    });
    expect(strict.stats().blocked[0]).toMatchObject({
      host: "10.1.1.1",
      reason: "private-address",
    });
  });
});
