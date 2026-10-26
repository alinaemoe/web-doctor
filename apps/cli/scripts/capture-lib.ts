import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { createApiServer } from "@webdoctor/api";

export const root = fileURLToPath(new URL("../../..", import.meta.url));
export const outImages = join(root, "docs/screenshots");
export const TOKEN = "docs";
export const log = (message: string) => console.log(`[docs] ${message}`);
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outImages, { recursive: true });

export type Api = Awaited<ReturnType<typeof createApiServer>>;

/** Window size for stills (rendered at 2x) and for GIF frames. */
export const SHOT_VIEW = { width: 1320, height: 800 };
export const GIF_VIEW = { width: 1240, height: 720 };

/** A pointer drawn into the page, so GIFs show where the click happens. */
const CURSOR_SCRIPT = `
(() => {
  const make = () => {
    if (document.getElementById("__cursor")) return;
    const dot = document.createElement("div");
    dot.id = "__cursor";
    dot.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;left:-50px;top:-50px;width:26px;height:26px;margin:-3px 0 0 -3px";
    dot.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7 18 2.6-7.4L20 10z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement("div");
    ring.id = "__ring";
    ring.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #2f81f7;opacity:0";
    document.documentElement.append(ring, dot);
    addEventListener("mousemove", (e) => {
      dot.style.left = ring.style.left = e.clientX + "px";
      dot.style.top = ring.style.top = e.clientY + "px";
    }, true);
    addEventListener("mousedown", () => { ring.style.opacity = "1"; setTimeout(() => (ring.style.opacity = "0"), 260); }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", make); else make();
})();
`;

/**
 * Puts a screenshot into a browser-style window on a soft background. `flat` skips the gradient and
 * the shadow, which keeps GIF palettes small.
 */
export async function frame(
  png: Buffer,
  options: { scale: number; flat?: boolean; address?: string },
): Promise<Buffer> {
  const s = options.scale;
  const meta = await sharp(png).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const pad = Math.round(26 * s);
  const bar = Math.round(36 * s);
  const radius = Math.round(10 * s);
  const total = h + bar;
  const address = options.address ?? "localhost:7777";

  const chrome = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${bar}">
      <rect width="${w}" height="${bar}" fill="#eef0f3"/>
      <circle cx="${18 * s}" cy="${bar / 2}" r="${5.5 * s}" fill="#ff5f57"/>
      <circle cx="${36 * s}" cy="${bar / 2}" r="${5.5 * s}" fill="#febc2e"/>
      <circle cx="${54 * s}" cy="${bar / 2}" r="${5.5 * s}" fill="#28c840"/>
      <rect x="${80 * s}" y="${7 * s}" width="${Math.min(360 * s, w - 100 * s)}" height="${bar - 14 * s}" rx="${6 * s}" fill="#ffffff" stroke="#d6dae0" stroke-width="${s}"/>
      <text x="${94 * s}" y="${bar / 2 + 4.5 * s}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${13 * s}" fill="#4b5563">${address}</text>
    </svg>`,
  );
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${total}"><rect width="${w}" height="${total}" rx="${radius}" fill="#fff"/></svg>`,
  );
  const stacked = await sharp({
    create: { width: w, height: total, channels: 4, background: "#ffffff" },
  })
    .composite([
      { input: chrome, left: 0, top: 0 },
      { input: png, left: 0, top: bar },
    ])
    .png()
    .toBuffer();
  const windowImg = await sharp(stacked)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const cw = w + pad * 2;
  const ch = total + pad * 2;
  const background = Buffer.from(
    options.flat
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><rect width="${cw}" height="${ch}" fill="#1b2438"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4cca"/><stop offset="0.55" stop-color="#7a3fd1"/><stop offset="1" stop-color="#d1479a"/></linearGradient></defs><rect width="${cw}" height="${ch}" fill="url(#g)"/></svg>`,
  );
  const layers: OverlayOptions[] = [];
  if (!options.flat) {
    const shadowShape = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><rect x="${pad}" y="${pad + Math.round(10 * s)}" width="${w}" height="${total}" rx="${radius}" fill="rgba(0,0,30,0.5)"/></svg>`,
    );
    layers.push({
      input: await sharp(shadowShape)
        .blur(12 * s)
        .png()
        .toBuffer(),
      left: 0,
      top: 0,
    });
  }
  layers.push({ input: windowImg, left: pad, top: pad });
  return sharp(background).composite(layers).png().toBuffer();
}

export async function shot(
  page: Page,
  file: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  const raw = await page.screenshot({ type: "png", fullPage: options.fullPage });
  const framed = await frame(raw, { scale: 2 });
  const small = await sharp(framed)
    .png({ palette: true, quality: 90, effort: 8, colours: 256 })
    .toBuffer();
  writeFileSync(join(outImages, file), small);
  log(`${file}: ${(small.length / 1024).toFixed(0)} KB`);
}

export async function open(
  browser: Browser,
  base: string,
  hash: string,
  options: {
    view?: { width: number; height: number };
    scheme?: "light" | "dark";
    scale?: number;
    cursor?: boolean;
  } = {},
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: options.view ?? SHOT_VIEW,
    deviceScaleFactor: options.scale ?? 2,
    colorScheme: options.scheme ?? "light",
  });
  if (options.cursor) await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  await page.goto(`${base}/?token=${TOKEN}${hash}`);
  await page.waitForLoadState("networkidle");
  return { page, context };
}

export async function serve(
  options: Parameters<typeof createApiServer>[0],
): Promise<{ app: Api; base: string }> {
  const app = await createApiServer(options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return { app, base: `http://127.0.0.1:${port}` };
}

export const runPage = (id: string, issue?: string) =>
  `#/runs/${encodeURIComponent(id)}${issue ? `?issue=${encodeURIComponent(issue)}` : ""}`;

/** Collects frames while a scripted visitor uses the page, then writes an animated GIF. */
export class Recorder {
  private frames: { png: Buffer; delay: number }[] = [];
  private x = 60;
  private y = 60;

  constructor(private readonly page: Page) {}

  async snap(delay = 120): Promise<void> {
    this.frames.push({ png: await this.page.screenshot({ type: "png" }), delay });
  }

  /** Keeps the current picture on screen a little longer. */
  hold(ms: number): void {
    const last = this.frames.at(-1);
    if (last) last.delay += ms;
  }

  async moveTo(target: Locator, steps = 7): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("target is not visible");
    const tx = box.x + Math.min(box.width / 2, 140);
    const ty = box.y + box.height / 2;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const ease = k * k * (3 - 2 * k);
      await this.page.mouse.move(this.x + (tx - this.x) * ease, this.y + (ty - this.y) * ease);
      await this.snap(40);
    }
    this.x = tx;
    this.y = ty;
  }

  async click(target: Locator, after = 600): Promise<void> {
    await this.moveTo(target);
    await this.page.mouse.down();
    await this.snap(70);
    await this.page.mouse.up();
    await pause(after);
    await this.snap(160);
  }

  async type(target: Locator, text: string): Promise<void> {
    await this.moveTo(target);
    await this.page.mouse.down();
    await this.page.mouse.up();
    for (const [i, ch] of [...text].entries()) {
      await this.page.keyboard.type(ch);
      if (i % 2 === 1 || i === text.length - 1) await this.snap(50);
    }
    await this.snap(300);
  }

  async key(key: string, after = 450, delay = 380): Promise<void> {
    await this.page.keyboard.press(key);
    await pause(after);
    await this.snap(delay);
  }

  async save(file: string, width = 960): Promise<void> {
    const delays = this.frames.map((f) => f.delay);
    const sized = await Promise.all(
      this.frames.map(async (f) => {
        const framed = await frame(f.png, { scale: 1, flat: true });
        return sharp(framed).resize({ width }).png().toBuffer();
      }),
    );
    const gif = await sharp(sized, { join: { animated: true } })
      .gif({ delay: delays, loop: 0, colours: 96, effort: 7, dither: 0.5 })
      .toBuffer();
    writeFileSync(join(outImages, file), gif);
    if (process.env.DOCS_DEBUG) {
      const picks = [
        0,
        Math.floor(sized.length * 0.3),
        Math.floor(sized.length * 0.6),
        sized.length - 1,
      ];
      for (const i of picks)
        writeFileSync(join(process.env.DOCS_DEBUG, `${file}-${i}.png`), sized[i]!);
    }
    log(`${file}: ${this.frames.length} frames, ${(gif.length / 1024 / 1024).toFixed(2)} MB`);
  }
}
