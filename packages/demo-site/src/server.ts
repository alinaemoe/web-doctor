import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BACKPACK_SVG,
  BADGE_SVG,
  categorySlugs,
  renderAbout,
  renderCart,
  renderCategories,
  renderCategory,
  renderCheckout,
  renderCss,
  renderFlaky,
  renderHome,
  renderNewArrivals,
  renderOrphan,
  renderProduct,
  renderRobots,
  renderSitemap,
  renderSizeGuide,
  renderStorefrontJs,
} from "./pages";
import type { Mode, RenderContext } from "./pages";

export interface DemoOptions {
  mode?: Mode;
  /** Main site port. 0 = random free port. */
  port?: number;
  /** "External" site port (a different origin). 0 = random free port. */
  extPort?: number;
  host?: string;
}

export interface DemoSite {
  url: string;
  extUrl: string;
  getMode(): Mode;
  setMode(mode: Mode): void;
  /** While true, `/flaky` answers 503 (a page that is unreachable on the next run). */
  setFlakyDown(down: boolean): void;
  /** Make one path (for example "/cart") answer 503 until switched back. */
  setPathDown(path: string, down: boolean): void;
  close(): Promise<void>;
}

const HTML = "text/html; charset=utf-8";

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(req.method === "HEAD" ? undefined : body);
}

function redirect(req: IncomingMessage, res: ServerResponse, location: string): void {
  send(req, res, 301, HTML, "", { location });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startDemoSite(options: DemoOptions = {}): Promise<DemoSite> {
  const host = options.host ?? "127.0.0.1";
  let mode: Mode = options.mode ?? "broken";
  let flakyDown = false;
  /** Paths that answer 503 (a page that is down during a scan). */
  const downPaths = new Set<string>();

  // The "external" origin: another port is another origin; it always answers 429.
  const ext = createServer((req, res) => {
    send(req, res, 429, "text/plain", "Too Many Requests", { "retry-after": "60" });
  });
  const extPort = await listen(ext, options.extPort ?? 0, host);
  const extOrigin = `http://${host}:${extPort}`;

  const main = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? host}`;
    const ctx: RenderContext = { mode, origin, extOrigin };
    const path = new URL(req.url ?? "/", origin).pathname;

    if (req.method === "POST" && path.startsWith("/__demo/")) {
      const [, , kind, value] = path.split("/");
      if (kind === "mode" && (value === "broken" || value === "fixed")) mode = value;
      else if (kind === "flaky" && (value === "down" || value === "up"))
        flakyDown = value === "down";
      else if ((kind === "down" || kind === "up") && value) {
        const target = decodeURIComponent(value);
        if (kind === "down") downPaths.add(target);
        else downPaths.delete(target);
      } else return send(req, res, 404, "text/plain", "unknown control");
      return send(
        req,
        res,
        200,
        "application/json",
        JSON.stringify({ mode, flakyDown, down: [...downPaths] }),
      );
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(req, res, 405, "text/plain", "Method Not Allowed");
    }

    if (downPaths.has(path)) {
      return send(req, res, 503, "text/plain", "Service Unavailable");
    }

    const category = /^\/category\/(cat-\d{2})$/.exec(path)?.[1];
    if (category && categorySlugs.includes(category)) {
      return send(req, res, 200, HTML, renderCategory(ctx, category));
    }

    switch (path) {
      case "/":
        return send(req, res, 200, HTML, renderHome(ctx));
      case "/categories":
        return send(req, res, 200, HTML, renderCategories(ctx));
      case "/products/backpack":
        return send(req, res, 200, HTML, renderProduct(ctx));
      case "/about":
        return send(req, res, 200, HTML, renderAbout(ctx));
      case "/checkout":
        return send(req, res, 200, HTML, renderCheckout(ctx));
      case "/cart":
        return send(req, res, 200, HTML, renderCart(ctx));
      case "/size-guide":
        return send(req, res, 200, HTML, renderSizeGuide(ctx));
      case "/orphan":
        return send(req, res, 200, HTML, renderOrphan(ctx));
      case "/new-arrivals":
        return send(req, res, 200, HTML, renderNewArrivals(ctx));
      case "/flaky":
        return flakyDown
          ? send(req, res, 503, "text/plain", "Service Unavailable")
          : send(req, res, 200, HTML, renderFlaky(ctx));
      // redirect chain (3 hops) and a redirect loop
      case "/old":
        return redirect(req, res, "/old-2");
      case "/old-2":
        return redirect(req, res, "/old-3");
      case "/old-3":
        return redirect(req, res, "/new-arrivals");
      case "/loop-a":
        return redirect(req, res, "/loop-b");
      case "/loop-b":
        return redirect(req, res, "/loop-a");
      case "/sitemap.xml":
        return send(req, res, 200, "application/xml", renderSitemap(ctx));
      case "/robots.txt":
        return send(req, res, 200, "text/plain", renderRobots(ctx));
      case "/assets/site.css":
        return send(req, res, 200, "text/css", renderCss(mode));
      case "/assets/storefront.js":
        return send(req, res, 200, "text/javascript", renderStorefrontJs(mode));
      case "/img/backpack.svg":
        return send(req, res, 200, "image/svg+xml", BACKPACK_SVG);
      case "/img/badge.svg":
        return send(req, res, 200, "image/svg+xml", BADGE_SVG);
      default:
        // also covers /gone, /missing-page, /img/backpack-missing.jpg, /fonts/missing.woff2
        return send(
          req,
          res,
          404,
          HTML,
          "<!doctype html><title>Not found</title><h1>Not found</h1>",
        );
    }
  });
  const mainPort = await listen(main, options.port ?? 0, host);

  return {
    url: `http://${host}:${mainPort}`,
    extUrl: extOrigin,
    getMode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    setFlakyDown: (down) => {
      flakyDown = down;
    },
    setPathDown: (path, down) => {
      if (down) downPaths.add(path);
      else downPaths.delete(path);
    },
    close: async () => {
      await Promise.all([closeServer(main), closeServer(ext)]);
    },
  };
}
