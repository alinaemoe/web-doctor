import { isSameOrigin, normalizeUrl } from "@webdoctor/core";
import type {
  AxeViolation,
  Evidence,
  ElementInfo,
  ImageInfo,
  PageSnapshot,
  Severity,
} from "@webdoctor/core";
import { makeDraft, pagePathOf } from "./draft";
import { stabilizeSelector } from "./selectors";
import type { IssueDraft, SiteContext } from "./draft";

/** Tiles served by map providers (Google, Mapbox, OpenStreetMap, ...). */
const MAP_TILE =
  /(?:maps\.(?:googleapis|gstatic)\.com|api\.mapbox\.com|tile\.openstreetmap\.org|\.tile\.|\/tiles?\/)/i;

/** Horizontal overflow up to this many pixels is ignored. */
export const OVERFLOW_TOLERANCE_PX = 4;

export const THRESHOLDS = {
  imageBytes: 500 * 1024,
  scriptBytes: 300 * 1024,
  stylesheetBytes: 200 * 1024,
  pageBytes: 3 * 1024 * 1024,
};

const domEvidence = (el: ElementInfo): Evidence => ({
  type: "dom",
  selector: el.selector,
  htmlSnippet: el.htmlSnippet,
  boundingBox: el.boundingBox,
  nodeSignature: el.nodeSignature,
});

/** For "this element/tag is missing" rules where there is no element to point at. */
const absentDom = (selector: string, note: string, domPath = selector): Evidence => ({
  type: "dom",
  selector,
  htmlSnippet: note,
  nodeSignature: { domPath },
});

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

// ---------------------------------------------------------------- resources

const RESOURCE_RULE: Record<string, { ruleId: string; label: string } | undefined> = {
  image: { ruleId: "res.img.failed", label: "image" },
  font: { ruleId: "res.font.failed", label: "font" },
  script: { ruleId: "res.script.failed", label: "script" },
  stylesheet: { ruleId: "res.css.failed", label: "stylesheet" },
  fetch: { ruleId: "runtime.request.failed", label: "request" },
  xhr: { ruleId: "runtime.request.failed", label: "request" },
};

function resourceFailures(page: PageSnapshot): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  for (const entry of page.network) {
    const rule = RESOURCE_RULE[entry.resourceType];
    if (!rule) continue;
    const failedByStatus = entry.status !== undefined && entry.status >= 400;
    // ERR_ABORTED = the browser canceled it (navigation, ad blocking); not a site defect.
    const failedByNetwork = Boolean(entry.errorText) && !/ERR_ABORTED/.test(entry.errorText ?? "");
    if (!failedByStatus && !failedByNetwork) continue;

    const outcome = failedByStatus
      ? `responded with ${entry.status}`
      : `failed (${entry.errorText})`;
    const evidence: Evidence[] = [
      {
        type: "network",
        requestUrl: entry.url,
        method: entry.method,
        status: entry.status,
        redirectChain: entry.redirectChain.length ? entry.redirectChain : undefined,
        resourceType: entry.resourceType,
        errorText: entry.errorText,
      },
    ];
    let where = `Page ${pagePathOf(page.url)}`;
    if (entry.resourceType === "image") {
      const img = page.images.find((i) => i.src === entry.url);
      if (img) {
        evidence.push(domEvidence(img));
        where += `, element ${img.selector}`;
      }
    }
    drafts.push(
      makeDraft({
        ruleId: rule.ruleId,
        page,
        evidence,
        what: `The ${rule.label} ${entry.url} ${outcome}.`,
        where,
        confidence: 1,
      }),
    );
  }
  return drafts;
}

// ------------------------------------------------------------ accessibility

const IMPACT_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};

const AXE_HINTS: Record<string, { after?: string; howToFix: string }> = {
  "image-alt": {
    howToFix:
      'Add a meaningful alt text if the image carries information, or alt="" if it is decorative.',
    after: '<img src="…" alt="Short description">',
  },
  label: {
    howToFix:
      "Associate a visible <label for> with the field, or add aria-label if there is no visible text.",
    after: '<label for="email">Email</label>\n<input id="email" type="email">',
  },
  "button-name": {
    howToFix: "Give the button visible text or an aria-label that describes its action.",
    after: '<button type="button" aria-label="Apply coupon">…</button>',
  },
  "html-has-lang": {
    howToFix:
      'Add a lang attribute with the page language to the <html> element. On a multilingual site set it per language, for example lang="cs" on the Czech pages.',
    after: '<html lang="en">',
  },
  "role-img-alt": {
    howToFix:
      'Give every role="img" element a short aria-label that describes the image. If it is purely decorative, remove role="img" (and the empty aria-label/title) or mark it aria-hidden="true".',
    after: '<div role="img" aria-label="Courtyard of Lobkowicz Palace" class="slide"></div>',
  },
  "nested-interactive": {
    howToFix:
      'A container whose role hides its children from assistive technology (for example role="img" or role="button") must not contain links or buttons. Remove that role from the container, or move the interactive element out of it.',
  },
  list: {
    howToFix:
      "Only <li> (plus <script> and <template>) may be direct children of <ul> and <ol>. Wrap each direct child, such as the <a>, in an <li>, or use a <div>/<nav> instead of a list.",
    after: '<ul class="left-nav"><li><a href="/en">CoolPass</a></li></ul>',
  },
  "link-name": {
    howToFix:
      "Give each link visible text or an aria-label. For image-only links (such as app-store badges) add a descriptive alt to the image or an aria-label to the link.",
    after:
      '<a href="https://example.com/app" aria-label="Download on the App Store"><img src="badge.svg" alt=""></a>',
  },
  "aria-allowed-attr": {
    howToFix:
      "Remove ARIA attributes that the element's role does not support, or give the element the role that does (aria-selected belongs on role=option/tab/row, not on a plain div). If a third-party widget generates the markup, update or configure that widget.",
  },
  "aria-required-children": {
    howToFix:
      "An element with this ARIA role must contain the child roles it requires (a role=listbox needs role=option children). Fix the markup, or the configuration of the widget that renders it.",
  },
  "aria-input-field-name": {
    howToFix:
      'Give the control an accessible name with aria-label or aria-labelledby (for a custom select: aria-label="Language").',
    after: '<div role="listbox" aria-label="Language">…</div>',
  },
  "label-content-name-mismatch": {
    howToFix:
      "Make the accessible name (aria-label) contain the visible text of the control, ideally starting with it, so voice-control users can say what they see.",
  },
  "color-contrast": {
    howToFix:
      "Use a darker text color or a lighter background to reach the required contrast ratio.",
  },
};

/** "Fix any of the following:\n  a\n  b" -> "Fix any of the following: a; b." */
export function summarizeFailure(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const lines = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const [first, ...items] = lines;
  if (items.length === 0) return first;
  const head = first!.endsWith(":") ? first : `${first}:`;
  return `${head} ${items.join("; ")}.`;
}

/**
 * Disabled controls are exempt from the contrast requirement. axe only knows the `disabled`
 * attribute; sites often mark them with a class, so look at the element's own opening tag.
 */
export function isInactiveControl(html: string): boolean {
  const openTag = /^<[^>]*>/.exec(html.trim())?.[0] ?? "";
  return (
    /\sdisabled(?:[\s=>]|$)/i.test(openTag) ||
    /aria-disabled="true"/i.test(openTag) ||
    /class="(?:[^"]*\s)?(?:is-)?disabled(?:\s[^"]*)?"/i.test(openTag)
  );
}

/** Elements shown as evidence per axe finding; the rest are only counted. */
const MAX_AXE_EXAMPLES = 5;

/**
 * One issue per axe rule and page, not one per element: a page with 300 unlabeled icons has one
 * problem to fix ("label the icons"), not 300. The element count is kept as evidence.
 */
function axeIssues(page: PageSnapshot): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  for (const violation of page.axe as AxeViolation[]) {
    const nodes =
      violation.id === "color-contrast"
        ? violation.nodes.filter((n) => !isInactiveControl(n.html))
        : violation.nodes;
    if (nodes.length === 0) continue;
    const hint = AXE_HINTS[violation.id];
    const severity = IMPACT_SEVERITY[violation.impact ?? "minor"] ?? "low";
    const count = nodes.length;
    const first = nodes[0]!;

    const evidence: Evidence[] = [
      {
        type: "metric",
        name: "affectedElements",
        value: count,
        threshold: 0,
        unit: count === 1 ? "element" : "elements",
      },
      ...nodes.slice(0, MAX_AXE_EXAMPLES).map((node): Evidence => {
        const idMatch = /\sid="([^"]+)"/.exec(node.html);
        return {
          type: "dom",
          selector: node.target,
          htmlSnippet: node.html,
          boundingBox: node.boundingBox,
          nodeSignature: { id: idMatch?.[1], domPath: stabilizeSelector(node.target) },
        };
      }),
    ];

    drafts.push(
      makeDraft({
        ruleId: `a11y.axe.${violation.id}`,
        page,
        evidence,
        aggregateKey: "axe",
        title: violation.help,
        severity,
        confidence: violation.id === "color-contrast" ? 0.8 : 0.9,
        what:
          count === 1
            ? `${violation.help}. 1 element on this page.`
            : `${violation.help}. ${count} elements on this page.`,
        where: `Page ${pagePathOf(page.url)}, for example ${first.target}`,
        howToFix: [
          hint?.howToFix ?? summarizeFailure(first.failureSummary) ?? violation.help,
          `Rule details: ${violation.helpUrl}`,
        ].join(" "),
        after: hint?.after,
        info: {
          category: "accessibility",
          why: `${violation.description}. Automated checks cover only part of WCAG; manual testing is still needed.`,
          docsUrl: violation.helpUrl,
          verifyCriterion: "axe-core no longer reports this rule on the page.",
        },
      }),
    );
  }
  return drafts;
}

// ---------------------------------------------------------------------- SEO

function seoIssues(page: PageSnapshot, site: SiteContext): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const where = `Page ${pagePathOf(page.url)}`;

  if (page.title === null || page.title.trim() === "") {
    drafts.push(
      makeDraft({
        ruleId: "seo.title.missing",
        page,
        evidence: [
          absentDom(
            "head > title",
            page.title === null ? "(no <title> element)" : "<title></title>",
          ),
        ],
        what: page.title === null ? "The page has no <title> element." : "The <title> is empty.",
        where,
        after: "<title>Backpack — Broken Shop</title>",
      }),
    );
  }

  if (!page.metaDescription || page.metaDescription.trim() === "") {
    drafts.push(
      makeDraft({
        ruleId: "seo.description.missing",
        page,
        evidence: [absentDom('head > meta[name="description"]', "(no meta description)")],
        what: "The page has no meta description.",
        where,
        after: '<meta name="description" content="A short summary of the page.">',
      }),
    );
  }

  if (page.h1s.length === 0) {
    const main = page.mainElement;
    drafts.push(
      makeDraft({
        ruleId: "seo.h1.missing",
        page,
        evidence: [main ? domEvidence(main) : absentDom("body", "(no <h1>)")],
        what: "The page has no <h1> heading.",
        where: `${where}, inside ${main?.selector ?? "body"}`,
        after: "<h1>Page title</h1>",
      }),
    );
  } else if (page.h1s.length > 1) {
    drafts.push(
      makeDraft({
        ruleId: "seo.h1.multiple",
        page,
        evidence: page.h1s.slice(0, 5).map(domEvidence),
        what: `The page has ${page.h1s.length} <h1> elements.`,
        where,
        confidence: 0.5,
      }),
    );
  }

  if (page.canonical !== null) drafts.push(...canonicalIssues(page, site));
  return drafts;
}

function canonicalIssues(page: PageSnapshot, site: SiteContext): IssueDraft[] {
  const raw = page.canonical ?? "";
  const snippet = `<link rel="canonical" href="${raw}">`;
  const dom = absentDom('head > link[rel="canonical"]', snippet);
  const where = `Page ${pagePathOf(page.url)}`;
  const target = raw ? normalizeUrl(raw, page.finalUrl) : null;

  if (!target) {
    return [
      makeDraft({
        ruleId: "seo.canonical.invalid",
        page,
        evidence: [dom],
        what: `The canonical URL "${raw}" is empty or not a valid http(s) URL.`,
        where,
        confidence: 0.9,
      }),
    ];
  }

  const check = site.check(target);
  if (!check || check.error) return [];
  // Cross-origin canonicals are legitimate for syndicated content; do not judge them.
  if (!isSameOrigin(target, page.finalUrl)) return [];

  const net: Evidence = {
    type: "network",
    requestUrl: target,
    method: "GET",
    status: check.status,
    redirectChain: check.chain.length
      ? [...check.chain.map((h) => h.url), check.finalUrl ?? ""]
      : undefined,
    resourceType: "document",
  };
  if ((check.status ?? 0) >= 400) {
    return [
      makeDraft({
        ruleId: "seo.canonical.invalid",
        page,
        evidence: [dom, net],
        what: `The canonical URL ${target} responds with ${check.status}.`,
        where,
        confidence: 0.95,
      }),
    ];
  }
  if (check.chain.length > 0) {
    return [
      makeDraft({
        ruleId: "seo.canonical.invalid",
        page,
        evidence: [dom, net],
        what: `The canonical URL ${target} redirects (${check.chain.length} hop(s)) instead of being the final URL.`,
        where,
        confidence: 0.7,
      }),
    ];
  }
  return [];
}

// ------------------------------------------------------------------ runtime

function runtimeIssues(page: PageSnapshot): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const where = `Page ${pagePathOf(page.url)}`;

  for (const entry of page.console) {
    if (entry.level === "warning") continue;
    // Resource load failures are reported by the resource rules with better evidence.
    if (/^Failed to load resource/.test(entry.text)) continue;
    drafts.push(
      makeDraft({
        ruleId: "runtime.console.error",
        page,
        evidence: [
          { type: "console", level: entry.level, text: entry.text, source: entry.location },
        ],
        what: `The console reports: ${entry.text}`,
        where,
        confidence: 0.8,
      }),
    );
  }

  let total = 0;
  for (const entry of page.network) {
    if (entry.sizeBytes === undefined) continue;
    total += entry.sizeBytes;
    const limit =
      entry.resourceType === "image"
        ? THRESHOLDS.imageBytes
        : entry.resourceType === "script"
          ? THRESHOLDS.scriptBytes
          : entry.resourceType === "stylesheet"
            ? THRESHOLDS.stylesheetBytes
            : undefined;
    if (limit === undefined || entry.sizeBytes <= limit) continue;
    drafts.push(
      makeDraft({
        ruleId: "runtime.resource.heavy",
        page,
        evidence: [
          {
            type: "metric",
            name: "transferSize",
            value: entry.sizeBytes,
            threshold: limit,
            unit: "bytes",
          },
          {
            type: "network",
            requestUrl: entry.url,
            method: entry.method,
            status: entry.status,
            resourceType: entry.resourceType,
            sizeBytes: entry.sizeBytes,
          },
        ],
        what: `The ${entry.resourceType} ${entry.url} transfers ${kb(entry.sizeBytes)} (limit ${kb(limit)}).`,
        where,
        confidence: 0.8,
      }),
    );
  }
  if (total > THRESHOLDS.pageBytes) {
    drafts.push(
      makeDraft({
        ruleId: "runtime.resource.heavy",
        page,
        title: "Page is heavy",
        evidence: [
          {
            type: "metric",
            name: "pageWeight",
            value: total,
            threshold: THRESHOLDS.pageBytes,
            unit: "bytes",
          },
        ],
        what: `The page downloads ${kb(total)} in total (limit ${kb(THRESHOLDS.pageBytes)}).`,
        where,
        confidence: 0.8,
      }),
    );
  }

  for (const img of page.images as ImageInfo[]) {
    if (!img.boundingBox || (img.hasWidthAttr && img.hasHeightAttr)) continue;
    // Inline data: images and third-party widgets (maps) are not the site owner's to fix.
    if (img.inWidget || img.src.startsWith("data:") || !img.src || MAP_TILE.test(img.src)) continue;
    drafts.push(
      makeDraft({
        ruleId: "runtime.img.no-dimensions",
        page,
        evidence: [domEvidence(img)],
        what: `The image ${img.src || "(no src)"} has no ${!img.hasWidthAttr ? "width" : "height"} attribute.`,
        where: `${where}, element ${img.selector}`,
        confidence: 0.7,
        after: '<img src="…" alt="…" width="320" height="240">',
      }),
    );
  }

  const overflowPx = page.overflowX.scrollWidth - page.overflowX.clientWidth;
  // A few pixels is usually rounding or a scrollbar; report it only when a visitor would notice.
  if (page.viewport === "mobile" && overflowPx > OVERFLOW_TOLERANCE_PX) {
    drafts.push(
      makeDraft({
        ruleId: "runtime.overflow-x.mobile",
        page,
        evidence: [
          {
            type: "metric",
            name: "scrollWidth",
            value: page.overflowX.scrollWidth,
            threshold: page.overflowX.clientWidth,
            unit: "px",
          },
          ...page.overflowX.offenders.map(domEvidence),
        ],
        severity: overflowPx < 24 ? "low" : "medium",
        what: `The page is ${page.overflowX.scrollWidth}px wide on a ${page.overflowX.clientWidth}px mobile viewport.`,
        where,
        confidence: 0.9,
      }),
    );
  }

  return drafts;
}

export function pageRules(page: PageSnapshot, site: SiteContext): IssueDraft[] {
  return [
    ...resourceFailures(page),
    ...axeIssues(page),
    ...seoIssues(page, site),
    ...runtimeIssues(page),
  ];
}
