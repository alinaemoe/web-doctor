import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPolicy } from "./policy";
import { startGuardProxy } from "./proxy";
import type { GuardProxy } from "./proxy";

/** A web server that counts the requests it receives. */
async function webServer(body = "hello") {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/plain", "x-host": String(req.headers.host) });
    res.end(req.url === "/big" ? "x".repeat(200_000) : body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A TCP echo server that counts connections. */
async function echoServer() {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.on("data", (d) => socket.write(`echo:${d}`));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    connections: () => connections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Sends an absolute-form request to the proxy, as a browser would. */
function viaProxy(proxy: GuardProxy, target: string, path = "") {
  const p = new URL(proxy.url);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: p.hostname,
          port: p.port,
          method: "GET",
          path: target + path,
          headers: { host: new URL(target).host },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

/** CONNECT through the proxy; resolves with the status line and the tunnelled socket. */
function connectVia(proxy: GuardProxy, authority: string) {
  const p = new URL(proxy.url);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; socket: net.Socket }>(
    (resolve, reject) => {
      const req = http.request({
        host: p.hostname,
        port: p.port,
        method: "CONNECT",
        path: authority,
      });
      req.on("connect", (res, socket) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }),
      );
      req.on("response", (res) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, socket: res.socket }),
      );
      req.on("error", reject);
      req.end();
    },
  );
}

let allowed: Awaited<ReturnType<typeof webServer>>;
let secret: Awaited<ReturnType<typeof webServer>>;
let allowedEcho: Awaited<ReturnType<typeof echoServer>>;
let secretEcho: Awaited<ReturnType<typeof echoServer>>;
let proxy: GuardProxy;

beforeAll(async () => {
  allowed = await webServer("public page");
  secret = await webServer("INTERNAL SECRET");
  allowedEcho = await echoServer();
  secretEcho = await echoServer();
  proxy = await startGuardProxy({
    // only `allowed` and `allowedEcho` are on the operator's allow-list; everything else on
    // loopback is a stand-in for "internal network"
    policy: createPolicy({
      allowOrigins: [`http://127.0.0.1:${allowed.port}`, `https://127.0.0.1:${allowedEcho.port}`],
    }),
    maxBytes: 150_000,
  });
});
afterAll(async () => {
  await proxy.close();
  await Promise.all([allowed.close(), secret.close(), allowedEcho.close(), secretEcho.close()]);
});

describe("forwarding http", () => {
  it("passes an allowed request through and keeps the original Host header", async () => {
    const res = await viaProxy(proxy, `http://127.0.0.1:${allowed.port}`, "/page");
    expect(res.status).toBe(200);
    expect(res.body).toBe("public page");
    expect(res.headers["x-host"]).toBe(`127.0.0.1:${allowed.port}`);
    expect(allowed.hits()).toBe(1);
  });

  it("refuses an internal address and never touches the server behind it", async () => {
    const res = await viaProxy(proxy, `http://127.0.0.1:${secret.port}`, "/admin");
    expect(res.status).toBe(403);
    expect(res.headers["x-webdoctor-blocked"]).toBeDefined();
    expect(res.body).toBe("");
    expect(secret.hits()).toBe(0);
    expect(proxy.stats().blocked.at(-1)).toMatchObject({ host: "127.0.0.1" });
  });

  it("refuses the cloud metadata address without trying to connect", async () => {
    const started = Date.now();
    const res = await viaProxy(
      proxy,
      "http://169.254.169.254",
      "/latest/meta-data/iam/security-credentials/",
    );
    expect(res.status).toBe(403);
    expect(res.headers["x-webdoctor-blocked"]).toBe("private-address");
    // a real connection attempt would take seconds to time out
    expect(Date.now() - started).toBeLessThan(1500);
    const meta80 = await viaProxy(proxy, "http://169.254.169.254:80", "/");
    expect(meta80.status).toBe(403);
  });

  it("refuses a request that is not for a proxy, and https in absolute form", async () => {
    const p = new URL(proxy.url);
    const direct = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: p.hostname, port: p.port, path: "/just-a-path" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    expect(direct).toBe(400);
    const tls = await viaProxy(proxy, `https://127.0.0.1:${allowed.port}`, "/");
    expect(tls.status).toBe(403);
  });

  it("refuses credentials, odd schemes and internal host names", async () => {
    for (const target of [
      "http://user:pw@example.com",
      "http://localhost:80",
      "http://db.internal",
      "http://printer",
    ]) {
      expect((await viaProxy(proxy, target, "/")).status, target).toBe(403);
    }
  });
});

describe("tunnelling (CONNECT, used for https)", () => {
  it("opens a tunnel to an allowed host and relays bytes both ways", async () => {
    const { status, socket } = await connectVia(proxy, `127.0.0.1:${allowedEcho.port}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(String(d)));
      socket.write("ping");
    });
    expect(reply).toBe("echo:ping");
    socket.destroy();
    expect(allowedEcho.connections()).toBe(1);
  });

  it("refuses a tunnel to an internal service and never connects to it", async () => {
    const { status, headers } = await connectVia(proxy, `127.0.0.1:${secretEcho.port}`);
    expect(status).toBe(403);
    expect(headers["x-webdoctor-blocked"]).toBeDefined();
    expect(secretEcho.connections()).toBe(0);
  });

  it("refuses ports that are not web ports, even on public addresses", async () => {
    for (const authority of [
      "8.8.8.8:22",
      "8.8.8.8:3306",
      "1.1.1.1:6379",
      "[2606:4700:4700::1111]:25",
    ]) {
      const { status, headers } = await connectVia(proxy, authority);
      expect(status, authority).toBe(403);
      expect(headers["x-webdoctor-blocked"], authority).toBe("port");
    }
  });

  it("refuses internal IPv4, IPv6 and IPv6-wrapped IPv4 targets", async () => {
    for (const authority of [
      "10.0.0.1:443",
      "192.168.1.1:80",
      "169.254.169.254:80",
      "[::1]:443",
      "[fd00::1]:443",
      "[::ffff:127.0.0.1]:443",
      "localhost:443",
    ]) {
      const { status } = await connectVia(proxy, authority);
      expect(status, authority).toBe(403);
    }
  });

  it("rejects a malformed CONNECT target", async () => {
    const { status } = await connectVia(proxy, "no-port-here");
    expect(status).toBe(400);
  });
});

describe("limits", () => {
  it("cuts a transfer that exceeds the byte budget and refuses further traffic", async () => {
    expect(proxy.stats().budgetExceeded).toBe(false);
    await viaProxy(proxy, `http://127.0.0.1:${allowed.port}`, "/big").catch(() => undefined);
    await viaProxy(proxy, `http://127.0.0.1:${allowed.port}`, "/big").catch(() => undefined);
    expect(proxy.stats().budgetExceeded).toBe(true);
    const after = await viaProxy(proxy, `http://127.0.0.1:${allowed.port}`, "/page").catch(() => ({
      status: 0,
    }));
    expect([0, 509]).toContain(after.status);
    expect(proxy.stats().blocked.some((b) => b.reason === "byte-budget")).toBe(true);
  });
});

describe("lifecycle", () => {
  it("closes cleanly and stops accepting connections", async () => {
    const p = await startGuardProxy({ policy: createPolicy() });
    const port = Number(new URL(p.url).port);
    await p.close();
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1", () => resolve(true));
        s.on("error", reject);
      }),
    ).rejects.toBeDefined();
  });
});
