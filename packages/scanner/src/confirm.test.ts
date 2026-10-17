import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LinkCheck } from "@webdoctor/core";
import { checkLink } from "./linkCheck";
import { confirmInBrowser, needsBrowserConfirmation } from "./confirm";

/** A site that is hostile to scripts: only a real browser gets the page. */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const browser = /Chrome\//.test(String(req.headers["user-agent"]));
    if (req.url === "/gone") return void res.writeHead(404).end("missing");
    if (req.url === "/bot-hostile") {
      return browser
        ? void res.writeHead(200, { "content-type": "text/html" }).end("<h1>ok</h1>")
        : void res.writeHead(404).end("not found");
    }
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>ok</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("needsBrowserConfirmation", () => {
  const c = (status?: number): LinkCheck => ({
    url: "u",
    status,
    chain: [],
    loop: false,
    tooManyHops: false,
  });
  it("flags statuses a bot-blocking site may have faked", () => {
    for (const s of [403, 404, 410, 500, 503]) expect(needsBrowserConfirmation(c(s))).toBe(true);
    for (const s of [200, 301, 429, undefined]) expect(needsBrowserConfirmation(c(s))).toBe(false);
    expect(needsBrowserConfirmation(undefined)).toBe(false);
  });
});

describe("confirmInBrowser", () => {
  it("clears a link that only fails for scripts and keeps one that is really gone", async () => {
    const checks = new Map<string, LinkCheck>();
    for (const path of ["/bot-hostile", "/gone"])
      checks.set(base + path, await checkLink(base + path));
    expect(checks.get(base + "/bot-hostile")!.status).toBe(404);

    const changed = await confirmInBrowser(checks, [base + "/bot-hostile", base + "/gone"]);

    expect(changed).toBe(1);
    expect(checks.get(base + "/bot-hostile")).toMatchObject({
      status: 200,
      viaBrowser: true,
      chain: [],
    });
    expect(checks.get(base + "/gone")).toMatchObject({ status: 404 });
    expect(checks.get(base + "/gone")!.viaBrowser).toBeUndefined();
  }, 60_000);

  it("keeps the original result when the browser cannot load the page", async () => {
    const dead = "http://127.0.0.1:1/never";
    const before: LinkCheck = {
      url: dead,
      status: 503,
      chain: [],
      loop: false,
      tooManyHops: false,
    };
    const checks = new Map([[dead, before]]);
    expect(await confirmInBrowser(checks, [dead], { timeoutMs: 3000 })).toBe(0);
    expect(checks.get(dead)).toEqual(before);
  }, 60_000);

  it("does nothing, and starts no browser, for an empty list", async () => {
    expect(await confirmInBrowser(new Map(), [])).toBe(0);
  });
});
