import type { Category, Severity } from "@webdoctor/core";

/** Static knowledge about a rule: severity defaults and the generic "why / how to fix" text. */
export interface RuleInfo {
  category: Category;
  severity: Severity;
  title: string;
  why: string;
  howToFix: string;
  docsUrl?: string;
  /** What a re-check must show for the issue to count as fixed. */
  verifyCriterion: string;
}

const MDN = "https://developer.mozilla.org/en-US/docs/Web";

export const RULE_CATALOG: Record<string, RuleInfo> = {
  "link.internal.broken": {
    category: "links-resources",
    severity: "high",
    title: "Broken internal link",
    why: "Visitors following this link land on an error page, and search engines treat it as a dead end.",
    howToFix:
      "Point the link at an existing page, restore the missing page, or add a redirect from the old URL.",
    docsUrl: `${MDN}/HTTP/Status/404`,
    verifyCriterion: "The linked URL answers 2xx (or one redirect to a 2xx page).",
  },
  "link.internal.redirect-chain": {
    category: "links-resources",
    severity: "low",
    title: "Link goes through a redirect chain",
    why: "Every extra redirect adds a network round trip and can lose link signals for search engines.",
    howToFix: "Link directly to the final URL and collapse the chain into a single redirect.",
    docsUrl: `${MDN}/HTTP/Redirections`,
    verifyCriterion: "The link reaches its final URL in at most 2 redirects.",
  },
  "link.internal.redirect-loop": {
    category: "links-resources",
    severity: "high",
    title: "Link leads into a redirect loop",
    why: "Browsers give up after too many redirects, so visitors see an error instead of the page.",
    howToFix: "Fix the redirect rules so the URLs do not point at each other, or remove the link.",
    docsUrl: `${MDN}/HTTP/Redirections`,
    verifyCriterion: "The linked URL resolves to a final response without repeating a URL.",
  },
  "link.external.broken": {
    category: "links-resources",
    severity: "medium",
    title: "External link is broken or could not be verified",
    why: "A dead outbound link is a poor experience; unreliable results (rate limits, blocking) must not be mistaken for breakage.",
    howToFix:
      "If the target is really gone, update or remove the link. If the remote site blocks automated checks, verify it manually and ignore the issue.",
    verifyCriterion: "The external URL answers 2xx, or the issue is ignored after a manual check.",
  },
  "res.img.failed": {
    category: "links-resources",
    severity: "high",
    title: "Image failed to load",
    why: "Visitors see a broken image or an empty gap, and the browser may reserve the wrong amount of space.",
    howToFix: "Fix the image URL, upload the missing file, or remove the element.",
    docsUrl: `${MDN}/HTML/Element/img`,
    verifyCriterion: "The image request answers 2xx and the image renders.",
  },
  "res.font.failed": {
    category: "links-resources",
    severity: "medium",
    title: "Font failed to load",
    why: "The browser falls back to another font, which changes the layout and the brand look.",
    howToFix:
      "Fix the @font-face src URL or upload the missing font file. Add a close fallback font in font-family.",
    docsUrl: `${MDN}/CSS/@font-face`,
    verifyCriterion: "The font request answers 2xx.",
  },
  "res.script.failed": {
    category: "links-resources",
    severity: "high",
    title: "Script failed to load",
    why: "Features that depend on the script silently stop working.",
    howToFix: "Fix the script URL or deploy the missing file.",
    verifyCriterion: "The script request answers 2xx.",
  },
  "res.css.failed": {
    category: "links-resources",
    severity: "high",
    title: "Stylesheet failed to load",
    why: "The page renders unstyled or partially styled.",
    howToFix: "Fix the stylesheet URL or deploy the missing file.",
    verifyCriterion: "The stylesheet request answers 2xx.",
  },
  "seo.title.missing": {
    category: "seo",
    severity: "high",
    title: "Page has no title",
    why: "The title is shown in browser tabs and search results; without it the page is hard to identify.",
    howToFix: "Add a unique, descriptive <title> inside <head>.",
    docsUrl: `${MDN}/HTML/Element/title`,
    verifyCriterion: "The page has a non-empty <title>.",
  },
  "seo.description.missing": {
    category: "seo",
    severity: "medium",
    title: "Page has no meta description",
    why: "Search engines will pick an arbitrary snippet instead of your summary.",
    howToFix: 'Add <meta name="description" content="…"> with a short summary of the page.',
    docsUrl: `${MDN}/HTML/Element/meta/name`,
    verifyCriterion: "The page has a non-empty meta description.",
  },
  "seo.h1.missing": {
    category: "seo",
    severity: "medium",
    title: "Page has no <h1>",
    why: "The main heading tells visitors and assistive technology what the page is about.",
    howToFix:
      "Render one <h1> that names the page. If many pages share the issue, fix the shared template.",
    docsUrl: `${MDN}/HTML/Element/Heading_Elements`,
    verifyCriterion: "The page has exactly one non-empty <h1>.",
  },
  "seo.h1.multiple": {
    category: "seo",
    severity: "low",
    title: "Page has more than one <h1>",
    why: "Multiple <h1> elements are allowed, but they often signal a messy heading structure. This is a hint, not an error.",
    howToFix: "Keep one <h1> for the page topic and use <h2>–<h6> for sections.",
    docsUrl: `${MDN}/HTML/Element/Heading_Elements`,
    verifyCriterion: "The page has a single <h1>, or the structure is confirmed intentional.",
  },
  "seo.canonical.invalid": {
    category: "seo",
    severity: "medium",
    title: "Canonical URL is invalid",
    why: "A canonical link that is malformed, missing or redirecting confuses search engines about which URL to index.",
    howToFix:
      "Point rel=canonical at the absolute URL of an existing, directly reachable (2xx) page.",
    docsUrl: `${MDN}/HTML/Attributes/rel#canonical`,
    verifyCriterion: "The canonical URL is absolute and answers 2xx without redirects.",
  },
  "seo.sitemap.bad-entries": {
    category: "seo",
    severity: "medium",
    title: "Sitemap lists URLs that do not work",
    why: "Search engines waste crawl budget and may distrust a sitemap with dead URLs.",
    howToFix: "Remove or fix the failing entries; regenerate the sitemap from live pages only.",
    verifyCriterion: "All sitemap URLs on this site answer 2xx.",
  },
  "seo.sitemap.unreachable": {
    category: "seo",
    severity: "medium",
    title: "Sitemap declared in robots.txt is unreachable",
    why: "Search engines follow robots.txt to find the sitemap; a dead link means they never see it.",
    howToFix: "Publish the sitemap at the declared URL or fix the Sitemap line in robots.txt.",
    verifyCriterion: "The declared sitemap answers 200.",
  },
  "runtime.console.error": {
    category: "runtime",
    severity: "medium",
    title: "JavaScript error on the page",
    why: "Uncaught errors usually mean part of the page's behavior is broken.",
    howToFix: "Open DevTools on this page, reproduce the error and fix its cause.",
    verifyCriterion: "The page loads without this error in the console.",
  },
  "runtime.request.failed": {
    category: "runtime",
    severity: "medium",
    title: "Background request failed",
    why: "A failed fetch/XHR can leave the page without data.",
    howToFix: "Check the endpoint URL and the server logs, then handle the failure in the UI.",
    verifyCriterion: "The request answers 2xx.",
  },
  "runtime.resource.heavy": {
    category: "runtime",
    severity: "low",
    title: "Heavy resource",
    why: "Large downloads slow down loading, especially on mobile networks. (Basic diagnostic, not a full performance audit.)",
    howToFix:
      "Compress or split the resource: optimize images, minify and code-split scripts, enable compression.",
    verifyCriterion: "The resource is below the size threshold.",
  },
  "runtime.img.no-dimensions": {
    category: "runtime",
    severity: "low",
    title: "Image has no width/height",
    why: "Without dimensions the browser cannot reserve space, which can shift the layout when the image loads.",
    howToFix: "Add width and height attributes (or CSS aspect-ratio) matching the image.",
    docsUrl: `${MDN}/HTML/Element/img#width`,
    verifyCriterion: "The image has width and height attributes.",
  },
  "runtime.overflow-x.mobile": {
    category: "runtime",
    severity: "medium",
    title: "Page scrolls horizontally on mobile",
    why: "Content wider than the screen forces sideways scrolling and hides part of the page.",
    howToFix:
      "Find the element wider than the viewport and constrain it (max-width: 100%, wrapping, overflow).",
    verifyCriterion: "The document is not wider than the mobile viewport.",
  },
  "nav.page.orphan": {
    category: "seo",
    severity: "low",
    title: "Page cannot be reached by clicking links",
    why: "Visitors and search engines that follow links never find this page. It is known only from the sitemap or a direct address, so it gets no traffic from the site itself.",
    howToFix:
      "Link to it from a relevant page or the navigation. If the page is obsolete, remove it and take it out of the sitemap.",
    verifyCriterion: "At least one other page of the site links to this page.",
  },
  "nav.page.deep": {
    category: "seo",
    severity: "low",
    title: "Page is buried deep in the site",
    why: "Pages that need many clicks from the home page are rarely visited and are crawled less often by search engines.",
    howToFix:
      "Link the page from a higher-level page, a hub or the navigation, or add breadcrumbs and related links.",
    verifyCriterion: "The page is at most 4 clicks from the home page.",
  },
  "nav.page.dead-end": {
    category: "links-resources",
    severity: "info",
    title: "Page has no links to other pages of the site",
    why: "A visitor who finishes reading has no next step, and the page passes nothing on to the rest of the site.",
    howToFix:
      "Add the site navigation, related links, or a link back to the section this page belongs to.",
    verifyCriterion: "The page links to at least one other page of the site.",
  },
};

export function infoFor(ruleId: string): RuleInfo | undefined {
  return RULE_CATALOG[ruleId];
}
