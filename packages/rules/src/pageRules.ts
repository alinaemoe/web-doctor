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
import type { IssueDraft, SiteContext } from "./draft";

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
  "color-contrast": {
    howToFix:
      "Use a darker text color or a lighter background to reach the required contrast ratio.",
  },
};

function axeIssues(page: PageSnapshot): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  for (const violation of page.axe as AxeViolation[]) {
    const hint = AXE_HINTS[violation.id];
    const severity = IMPACT_SEVERITY[violation.impact ?? "minor"] ?? "low";
    for (const node of violation.nodes) {
      const idMatch = /\sid="([^"]+)"/.exec(node.html);
      const draft = makeDraft({
        ruleId: `a11y.axe.${violation.id}`,
        page,
        evidence: [
          {
            type: "dom",
            selector: node.target,
            htmlSnippet: node.html,
            boundingBox: node.boundingBox,
            nodeSignature: { id: idMatch?.[1], domPath: node.target },
          },
        ],
        title: violation.help,
        severity,
        confidence: violation.id === "color-contrast" ? 0.8 : 0.9,
        what: `${violation.help}.`,
        where: `Page ${pagePathOf(page.url)}, element ${node.target}`,
        howToFix: [
          hint?.howToFix ?? node.failureSummary?.replace(/\s+/g, " ").trim() ?? violation.help,
          `Rule details: ${violation.helpUrl}`,
        ].join(" "),
        after: hint?.after,
        info: {
          category: "accessibility",
          why: `${violation.description}. Automated checks cover only part of WCAG; manual testing is still needed.`,
          docsUrl: violation.helpUrl,
          verifyCriterion: "axe-core no longer reports this rule for the element.",
        },
      });
      drafts.push(draft);
    }
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

  if (page.viewport === "mobile" && page.overflowX.scrollWidth > page.overflowX.clientWidth + 1) {
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
