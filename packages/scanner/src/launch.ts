import { chromium } from "playwright";
import type { NetworkGuard } from "@webdoctor/netguard";

/**
 * The one place that starts Chromium. With a guard, every request is forced through the guard's
 * proxy. `WEBDOCTOR_CHROMIUM_SANDBOX=1` turns on Chromium's own sandbox (Playwright disables it by
 * default); it needs a host that allows user namespaces, so it is opt-in. On a public server the
 * container is the main sandbox either way (see docs/security.md).
 */
export function launchChromium(guard?: NetworkGuard) {
  return chromium.launch({
    chromiumSandbox: process.env.WEBDOCTOR_CHROMIUM_SANDBOX === "1",
    ...(guard ? { proxy: guard.browser.proxy, args: guard.browser.args } : {}),
  });
}
