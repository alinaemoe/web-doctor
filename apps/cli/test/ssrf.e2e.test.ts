import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "@webdoctor/api";
import { startDemoSite } from "@webdoctor/demo-site";
import type { DemoSite } from "@webdoctor/demo-site";
import { GuardError, createNetworkGuard } from "@webdoctor/netguard";
import { runScan } from "@webdoctor/runner";
import { scan } from "@webdoctor/scanner";
import type { ArtifactStore } from "@webdoctor/scanner";

/**
 * The point of public mode: whatever a hostile page does, the scanner's browser and HTTP client
 * must not reach private addresses. "Internal" is a real server on loopback that counts requests;
 * the test passes only if it was never contacted.
 */

const NO_ARTIFACTS: ArtifactStore = {
  write: async () => undefined,
  read: async () => new Uint8Array(),
};

let internal: http.Server;
let internalPort = 0;
const internalHits: string[] = [];
let hostile: http.Server;
let hostileOrigin = "";
let demo: DemoSite;
const out = mkdtempSync(join(tmpdir(), "wd-ssrf-"));

const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  internal = http.createServer((req, res) => {
    internalHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    res.end("<title>INTERNAL ADMIN</title><h1>secret</h1>");
  });
  internalPort = await listen(internal);
  const target = `http://127.0.0.1:${internalPort}`;

  // An allow-listed site that tries everything to reach the internal server.
  hostile = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/go") {
      res.writeHead(302, { location: `${target}/via-redirect` }).end();
    } else if (path === "/robots.txt") {
      res.writeHead(404).end();
    } else if (path === "/sitemap.xml") {
      res
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<urlset><url><loc>${target}/from-sitemap</loc></url></urlset>`);
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head>
        <title>Hostile page</title><meta name="description" content="x"></head><body><h1>Hostile</h1>
        <img src="${target}/pixel.png" alt="px">
        <iframe src="${target}/framed"></iframe>
        <script src="${target}/evil.js"></script>
        <script>
          fetch("${target}/by-fetch").catch(() => {});
          const x = new XMLHttpRequest(); x.open("GET", "${target}/by-xhr"); x.send();
          try { new WebSocket("ws://127.0.0.1:${internalPort}/ws"); } catch (e) {}
          fetch("http://169.254.169.254/latest/meta-data/").catch(() => {});
          fetch("http://[::1]:${internalPort}/v6").catch(() => {});
        </script>
        <a href="${target}/admin">admin</a>
        <a href="/go">redirects inward</a>
        <a href="http://169.254.169.254/latest/meta-data/">metadata</a>
        <a href="http://localhost:${internalPort}/by-name">by name</a>
        <a href="http://2130706433:${internalPort}/decimal">decimal</a>
        </body></html>`);
    }
  });
  const hostilePort = await listen(hostile);
  hostileOrigin = `http://127.0.0.1:${hostilePort}`;

  demo = await startDemoSite({ mode: "broken" });
}, 60_000);

afterAll(async () => {
  await demo.close();
  await new Promise<void>((r) => hostile.close(() => r()));
  await new Promise<void>((r) => internal.close(() => r()));
  rmSync(out, { recursive: true, force: true });
});

describe("a guarded scan", () => {
  it("refuses a private start address before opening a browser", async () => {
    const guard = await createNetworkGuard({});
    try {
      await expect(
        scan({ startUrl: `http://127.0.0.1:${internalPort}/`, artifacts: NO_ARTIFACTS, guard }),
      ).rejects.toBeInstanceOf(GuardError);
      await expect(
        scan({ startUrl: "http://169.254.169.254/", artifacts: NO_ARTIFACTS, guard }),
      ).rejects.toMatchObject({ reason: "private-address" });
      expect(internalHits).toEqual([]);
    } finally {
      await guard.close();
    }
  });

  it("never lets a hostile page (or its links, redirects, scripts) reach an internal server", async () => {
    const guard = await createNetworkGuard({ policy: { allowOrigins: [hostileOrigin] } });
    try {
      const result = await scan({
        startUrl: `${hostileOrigin}/`,
        artifacts: NO_ARTIFACTS,
        guard,
        maxPages: 3,
        viewports: ["desktop"],
        respectRobots: false,
        timeoutMs: 60_000,
      });
      // the page itself was scanned
      expect(result.pages.some((p) => p.url === `${hostileOrigin}/`)).toBe(true);
      // ...and nothing it pointed at was contacted
      expect(internalHits).toEqual([]);
      // links to forbidden addresses are "could not check", never a verdict about the target
      const checks = Object.entries(result.linkChecks).filter(([url]) =>
        /169\.254|127\.0\.0\.1:\d+\/(admin|via|from)|localhost|2130706433/.test(url),
      );
      expect(checks.length).toBeGreaterThan(0);
      for (const [url, check] of checks) {
        expect(check.status, url).toBeUndefined();
        expect(check.error, url).toBe("blocked");
      }
      // the proxy saw and refused the browser's attempts
      const blockedHosts = guard.stats().blocked.map((b) => b.host);
      expect(blockedHosts).toEqual(expect.arrayContaining(["127.0.0.1", "169.254.169.254"]));
    } finally {
      await guard.close();
    }
  }, 120_000);

  it("scans an allow-listed demo site normally", async () => {
    const guard = await createNetworkGuard({
      policy: { allowOrigins: [new URL(demo.url).origin, new URL(demo.extUrl).origin] },
    });
    try {
      const result = await scan({
        startUrl: demo.url,
        artifacts: NO_ARTIFACTS,
        guard,
        maxPages: 4,
        viewports: ["desktop"],
        timeoutMs: 90_000,
      });
      expect(result.pages.length).toBeGreaterThanOrEqual(3);
      expect(guard.stats().blocked).toEqual([]);
    } finally {
      await guard.close();
    }
  }, 120_000);
});

describe("the public API with the real guard", () => {
  it("rejects private targets, scans the allow-listed demo and keeps the run private", async () => {
    const app = await createApiServer({
      dataDir: out,
      public: {
        secret: "e2e",
        allowOrigins: [new URL(demo.url).origin, new URL(demo.extUrl).origin],
        limits: { maxPages: 3, maxDepth: 1 },
      },
    });
    try {
      const session = async () =>
        (await app.inject({ method: "POST", url: "/api/session" })).json().token as string;
      const [alice, bob] = [await session(), await session()];
      const as = (token: string) => ({ "x-webdoctor-token": token });

      const bad = await app.inject({
        method: "POST",
        url: "/api/scans",
        headers: as(alice),
        payload: { url: `http://127.0.0.1:${internalPort}/` },
      });
      expect(bad.statusCode).toBe(400);
      expect(internalHits).toEqual([]);

      const started = await app.inject({
        method: "POST",
        url: "/api/scans",
        headers: as(alice),
        payload: { url: demo.url, maxPages: 500, viewports: ["desktop"] },
      });
      expect(started.statusCode).toBe(202);
      const id = started.json().id;
      let job: { status: string; runId?: string; error?: string } = started.json();
      for (let i = 0; i < 200 && !["completed", "failed", "canceled"].includes(job.status); i++) {
        await new Promise((r) => setTimeout(r, 500));
        job = (await app.inject({ url: `/api/scans/${id}`, headers: as(alice) })).json();
      }
      expect(job, JSON.stringify(job)).toMatchObject({ status: "completed" });

      const mine = await app.inject({ url: `/api/runs/${job.runId}`, headers: as(alice) });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().run.settings.maxPages).toBeLessThanOrEqual(3);
      expect(
        (await app.inject({ url: `/api/runs/${job.runId}`, headers: as(bob) })).statusCode,
      ).toBe(404);
      expect((await app.inject({ url: "/api/runs", headers: as(bob) })).json()).toEqual([]);
    } finally {
      await app.close();
    }
  }, 180_000);

  it("is not reachable by the local-mode runScan without a guard (control: the attack is real)", async () => {
    // Without the guard the same hostile site DOES reach the internal server. This proves the
    // tests above would fail if the guard were missing.
    const before = internalHits.length;
    await runScan({
      url: `${hostileOrigin}/`,
      outDir: out,
      maxPages: 1,
      viewports: ["desktop"],
      respectRobots: false,
      formats: ["json"],
    });
    expect(internalHits.length).toBeGreaterThan(before);
  }, 120_000);
});
