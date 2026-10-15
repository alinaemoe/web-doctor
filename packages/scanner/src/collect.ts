import { createHash } from "node:crypto";
import axe from "axe-core";
import sharp from "sharp";
import type { Browser, Page, Request } from "playwright";
import type {
  AxeViolation,
  ConsoleEntry,
  NetworkEntry,
  PageSnapshot,
  ScanViewport,
} from "@webdoctor/core";
import type { ArtifactStore } from "./artifacts";
import { extractInPage } from "./extract";
import type { PageExtract } from "./extract";

export const VIEWPORTS: Record<ScanViewport, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1366, height: 768, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

export const MAX_SCREENSHOT_HEIGHT = 10_000;

export interface CollectOptions {
  viewport: ScanViewport;
  depth: number;
  artifacts: ArtifactStore;
  pageTimeoutMs: number;
  userAgent?: string;
}

export type CollectResult =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; reason: "non-html" | "navigation-error"; status?: number; detail: string };

/** Standards-based axe rules only; best-practice noise is left to our own SEO/runtime rules. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const AXE_EVAL = `
(async (tags) => {
  const results = await axe.run(document, {
    runOnly: { type: "tag", values: tags },
    resultTypes: ["violations"],
  });
  const boxOf = (target) => {
    try {
      const el = document.querySelector(target);
      if (!el) return undefined;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return undefined;
      return {
        x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width), height: Math.round(r.height),
      };
    } catch { return undefined; }
  };
  return results.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, description: v.description, helpUrl: v.helpUrl,
    tags: v.tags,
    nodes: v.nodes.map((n) => {
      const first = Array.isArray(n.target[0]) ? n.target[0].join(" >>> ") : String(n.target[0]);
      return {
        target: n.target.map((t) => Array.isArray(t) ? t.join(" >>> ") : String(t)).join(" >>> "),
        html: n.html.length > 300 ? n.html.slice(0, 300) + "…" : n.html,
        failureSummary: n.failureSummary,
        boundingBox: n.target.length === 1 ? boxOf(first) : undefined,
      };
    }),
  }));
})
`;

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(400, window.innerHeight - 100);
    const limit = Math.min(document.documentElement.scrollHeight, 12_000);
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
}

export async function collectPage(
  browser: Browser,
  url: string,
  options: CollectOptions,
): Promise<CollectResult> {
  const vp = VIEWPORTS[options.viewport];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    userAgent: options.userAgent,
  });

  try {
    // tsx/esbuild may wrap nested functions in `__name(...)`; make that a no-op inside pages.
    await context.addInitScript("window.__name = (fn) => fn;");
    const page = await context.newPage();

    const requests: { request: Request; entry: NetworkEntry }[] = [];
    const consoleEntries: ConsoleEntry[] = [];

    const chainOf = (request: Request): string[] => {
      const chain: string[] = [];
      for (let r = request.redirectedFrom(); r; r = r.redirectedFrom()) chain.unshift(r.url());
      return chain;
    };

    page.on("response", (response) => {
      const request = response.request();
      if (/^(data|blob):/.test(request.url())) return;
      requests.push({
        request,
        entry: {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          status: response.status(),
          redirectChain: chainOf(request),
        },
      });
    });
    page.on("requestfailed", (request) => {
      if (/^(data|blob):/.test(request.url())) return;
      requests.push({
        request,
        entry: {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          redirectChain: chainOf(request),
          errorText: request.failure()?.errorText ?? "request failed",
        },
      });
    });
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const loc = msg.location();
      consoleEntries.push({
        level: type,
        text: msg.text(),
        location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("pageerror", (error) => {
      consoleEntries.push({ level: "pageerror", text: error.message });
    });

    let response;
    try {
      response = await page.goto(url, { waitUntil: "load", timeout: options.pageTimeoutMs });
    } catch (error) {
      return {
        ok: false,
        reason: "navigation-error",
        detail: (error as Error).message.split("\n")[0] ?? "navigation failed",
      };
    }
    if (!response) {
      return { ok: false, reason: "navigation-error", detail: "no response" };
    }

    const status = response.status();
    const headers = await response.allHeaders();
    const contentType = headers["content-type"];
    if (contentType && !/html|xml/i.test(contentType)) {
      return { ok: false, reason: "non-html", status, detail: contentType };
    }

    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    await autoScroll(page).catch(() => undefined);
    await page.waitForTimeout(150);

    const extract: PageExtract = await page.evaluate(extractInPage);

    let violations: AxeViolation[] = [];
    try {
      await page.addScriptTag({ content: axe.source });
      violations = (await page.evaluate(
        `${AXE_EVAL}(${JSON.stringify(AXE_TAGS)})`,
      )) as AxeViolation[];
    } catch {
      // axe can fail on exotic pages; other categories still work.
    }

    // Body sizes are available only after loading finished.
    await Promise.all(
      requests.map(async ({ request, entry }) => {
        if (entry.errorText) return;
        try {
          const sizes = await request.sizes();
          if (sizes.responseBodySize >= 0) entry.sizeBytes = sizes.responseBodySize;
        } catch {
          // request object is gone; size stays unknown
        }
      }),
    );

    const height = Math.min(extract.fullHeight, MAX_SCREENSHOT_HEIGHT);
    const truncated = extract.fullHeight > MAX_SCREENSHOT_HEIGHT;
    let screenshotKey: string | undefined;
    try {
      const png = await page.screenshot({
        fullPage: true,
        type: "png",
        clip: { x: 0, y: 0, width: vp.width, height: Math.max(1, height) },
      });
      const webp = await sharp(png).webp({ quality: 80 }).toBuffer();
      const digest = createHash("sha1").update(url).digest("hex").slice(0, 10);
      screenshotKey = `screenshots/${digest}-${options.viewport}.webp`;
      await options.artifacts.write(screenshotKey, webp);
    } catch {
      screenshotKey = undefined;
    }

    // Redirect hops show up as their own 3xx responses; the final request carries the chain.
    const network = requests
      .map((r) => r.entry)
      .filter(
        (e) => e.errorText || (e.status !== undefined && (e.status < 300 || e.status >= 400)),
      );

    return {
      ok: true,
      snapshot: {
        url,
        finalUrl: page.url(),
        status,
        contentType,
        depth: options.depth,
        viewport: options.viewport,
        loadedAt: new Date().toISOString(),
        headers,
        title: extract.title,
        metaDescription: extract.metaDescription,
        canonical: extract.canonical,
        robotsMeta: extract.robotsMeta,
        htmlLang: extract.htmlLang,
        mainElement: extract.mainElement,
        h1s: extract.h1s,
        images: extract.images,
        links: extract.links,
        overflowX: extract.overflowX,
        network,
        console: consoleEntries,
        axe: violations,
        screenshotKey,
        fullHeight: extract.fullHeight,
        screenshotTruncated: truncated,
      },
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
