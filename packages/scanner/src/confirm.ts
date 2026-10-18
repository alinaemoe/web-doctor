import { launchChromium } from "./launch";
import type { LinkCheck } from "@webdoctor/core";
import type { NetworkGuard } from "@webdoctor/netguard";

/** Statuses where a plain HTTP client may have been treated differently from a real browser. */
export function needsBrowserConfirmation(check: LinkCheck | undefined): boolean {
  const status = check?.status;
  return (
    status === 404 || status === 410 || status === 403 || (status !== undefined && status >= 500)
  );
}

/**
 * Many sites answer scripted requests with 403/404 while a normal browser gets the page. Before a
 * link is reported as broken, load it the way a visitor would. If the browser gets a good answer
 * the link is fine; if the browser also fails (or cannot load it), the original result stays.
 * Updates `checks` in place.
 */
export async function confirmInBrowser(
  checks: Map<string, LinkCheck>,
  urls: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; guard?: NetworkGuard } = {},
): Promise<number> {
  if (urls.length === 0) return 0;
  const { guard } = options;
  const browser = await launchChromium(guard);
  let changed = 0;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const url of urls) {
      if (options.signal?.aborted) break;
      const before = checks.get(url);
      if (!before) continue;
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 12_000,
        });
        const status = response?.status();
        if (status !== undefined && status < 400) {
          checks.set(url, {
            ...before,
            status,
            finalUrl: page.url(),
            chain: [],
            loop: false,
            tooManyHops: false,
            error: undefined,
            errorText: undefined,
            viaBrowser: true,
          });
          changed++;
        }
      } catch {
        // the browser could not load it either; keep the original result
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return changed;
}
