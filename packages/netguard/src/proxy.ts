import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { GuardError, checkStatic, resolvePublic } from "./policy";
import type { GuardPolicy } from "./policy";

export interface BlockedRecord {
  host: string;
  reason: string;
  at: string;
}

export interface ProxyOptions {
  policy: GuardPolicy;
  /** Total bytes the browser may move through the proxy (default 400 MB). */
  maxBytes?: number;
  /** Simultaneous connections (default 128). */
  maxConnections?: number;
  /** Connections idle for this long are dropped (default 60 s). */
  idleMs?: number;
}

export interface GuardProxy {
  /** `http://127.0.0.1:<port>`: give this to the browser as its proxy. */
  url: string;
  stats(): { bytes: number; blocked: BlockedRecord[]; budgetExceeded: boolean };
  close(): Promise<void>;
}

const MAX_RECORDS = 50;

function splitHostPort(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

/**
 * A forward proxy that the scanner's browser is forced through. It is the one place where a request
 * is turned into a connection, so it can enforce the policy on EVERYTHING the page does: the
 * document, every subresource, redirects, fetch/XHR and WebSockets. The proxy resolves the name
 * itself, checks every address, and connects to the checked address (pinning): the browser's own
 * DNS never decides where a connection goes, which closes the DNS-rebinding gap.
 * HTTPS is tunnelled (CONNECT), so certificates and SNI stay the browser's business.
 */
export async function startGuardProxy(options: ProxyOptions): Promise<GuardProxy> {
  const { policy } = options;
  const maxBytes = options.maxBytes ?? 400 * 1024 * 1024;
  const idleMs = options.idleMs ?? 60_000;
  const sockets = new Set<Duplex>();
  const blocked: BlockedRecord[] = [];
  let bytes = 0;
  let budgetExceeded = false;

  const record = (host: string, reason: string) => {
    if (blocked.length < MAX_RECORDS) blocked.push({ host, reason, at: new Date().toISOString() });
  };

  const track = (socket: Duplex) => {
    if (sockets.has(socket)) return; // keep-alive connections carry many requests
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    if ("setTimeout" in socket) (socket as net.Socket).setTimeout(idleMs, () => socket.destroy());
  };

  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes && !budgetExceeded) {
      budgetExceeded = true;
      record("*", "byte-budget");
      for (const s of sockets) s.destroy();
    }
  };

  const refuse = (socket: Duplex, status: number, reason: string) => {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\n` +
        `x-webdoctor-blocked: ${reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
    );
  };

  const server = http.createServer(async (req, res) => {
    track(req.socket);
    if (budgetExceeded) return void res.writeHead(509).end();

    let host = "?";
    try {
      // a proxy request carries the whole address; anything else is someone talking to the proxy
      if (!/^https?:\/\//i.test(req.url ?? "")) {
        throw new GuardError("invalid-url", "not a proxy request");
      }
      try {
        host = new URL(req.url!).hostname;
      } catch {
        // checkStatic reports the malformed address
      }
      const target = checkStatic(req.url!, policy);
      if (target.url.protocol !== "http:") {
        throw new GuardError("scheme", "https must be tunnelled with CONNECT", host);
      }
      const resolved = await resolvePublic(target.hostname, policy, target.allowed);

      const headers: http.OutgoingHttpHeaders = {
        ...req.headers,
        host: target.url.host,
        connection: "close",
      };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = http.request(
        {
          host: resolved.address, // pinned: the address that was just checked
          port: target.port,
          method: req.method,
          path: target.url.pathname + target.url.search,
          headers,
          setHost: false,
          agent: false,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.on("data", count);
          response.pipe(res);
        },
      );
      upstream.setTimeout(idleMs, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("data", count);
      req.pipe(upstream);
    } catch (error) {
      const reason = error instanceof GuardError ? error.reason : "error";
      if (error instanceof GuardError && reason !== "invalid-url") record(host, reason);
      res.writeHead(reason === "invalid-url" ? 400 : 403, { "x-webdoctor-blocked": reason });
      res.end();
    }
  });

  server.on("connect", async (req, clientSocket: Duplex, head: Buffer) => {
    track(clientSocket);
    const hp = splitHostPort(req.url ?? "");
    if (!hp || budgetExceeded)
      return refuse(clientSocket, hp ? 403 : 400, hp ? "byte-budget" : "invalid-url");

    try {
      const target = checkStatic(`https://${hp.host}:${hp.port}`, policy);
      const resolved = await resolvePublic(target.hostname, policy, target.allowed);
      const upstream = net.connect({ host: resolved.address, port: target.port }); // pinned
      track(upstream);
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.on("data", count);
        clientSocket.on("data", count);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("error", () => refuse(clientSocket, 502, "upstream"));
    } catch (error) {
      const reason = error instanceof GuardError ? error.reason : "error";
      record(hp.host, reason);
      refuse(clientSocket, 403, reason);
    }
  });

  server.maxConnections = options.maxConnections ?? 128;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ bytes, blocked: [...blocked], budgetExceeded }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
