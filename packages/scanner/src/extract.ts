import type { ElementInfo, ImageInfo, LinkInfo } from "@webdoctor/core";

/**
 * Runs inside the page (serialized by Playwright), so it must be self-contained: no imports, no
 * references to outer scope. Returns plain JSON.
 */
export interface PageExtract {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  htmlLang: string | null;
  mainElement: ElementInfo | null;
  h1s: ElementInfo[];
  images: ImageInfo[];
  links: LinkInfo[];
  overflowX: { scrollWidth: number; clientWidth: number; offenders: ElementInfo[] };
  fullHeight: number;
}

export function extractInPage(): PageExtract {
  const MAX_SNIPPET = 300;

  const cssEscape = (value: string) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");

  function selectorOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id && document.querySelectorAll(`#${cssEscape(node.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      let part = tag;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  /** Same path without positional indexes: stable across list changes. */
  function domPathOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      parts.unshift(tag);
      if (tag === "body" || tag === "html") break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function boxOf(el: Element) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return undefined;
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  function nameOf(el: Element): string | undefined {
    const label =
      el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title");
    const text = label ?? (el.textContent ?? "").trim().replace(/\s+/g, " ");
    return text ? text.slice(0, 80) : undefined;
  }

  function infoOf(el: Element): ElementInfo {
    const html = el.outerHTML;
    return {
      selector: selectorOf(el),
      htmlSnippet: html.length > MAX_SNIPPET ? html.slice(0, MAX_SNIPPET) + "…" : html,
      boundingBox: boxOf(el),
      nodeSignature: {
        id: el.id || undefined,
        role: el.getAttribute("role") ?? undefined,
        accessibleName: nameOf(el),
        domPath: domPathOf(el),
      },
    };
  }

  const meta = (name: string) =>
    document.querySelector(`meta[name="${name}" i]`)?.getAttribute("content") ?? null;

  const images: ImageInfo[] = Array.from(document.querySelectorAll("img")).map((img) => ({
    ...infoOf(img),
    src: img.currentSrc || img.src,
    hasAltAttr: img.hasAttribute("alt"),
    hasWidthAttr: img.hasAttribute("width"),
    hasHeightAttr: img.hasAttribute("height"),
    naturalWidth: img.naturalWidth,
    complete: img.complete,
  }));

  const links: LinkInfo[] = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => ({
      ...infoOf(a),
      href: (a as HTMLAnchorElement).href,
      text: (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
    }))
    .filter((l) => /^https?:/i.test(l.href));

  const clientWidth = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  const offenders: ElementInfo[] =
    scrollWidth > clientWidth
      ? Array.from(document.body.querySelectorAll("*"))
          .filter((el) => el.getBoundingClientRect().right > clientWidth + 1)
          .slice(0, 5)
          .map(infoOf)
      : [];

  const main = document.querySelector("main") ?? document.body;

  return {
    title: document.title ? document.title : document.querySelector("title") ? "" : null,
    metaDescription: meta("description"),
    canonical: document.querySelector('link[rel="canonical" i]')?.getAttribute("href") ?? null,
    robotsMeta: meta("robots"),
    htmlLang: document.documentElement.getAttribute("lang"),
    mainElement: main ? infoOf(main) : null,
    h1s: Array.from(document.querySelectorAll("h1")).map(infoOf),
    images,
    links,
    overflowX: { scrollWidth, clientWidth, offenders },
    fullHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  };
}
