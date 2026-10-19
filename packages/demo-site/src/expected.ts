import type { Severity, UnverifiedReason, Verdict, Viewport } from "@webdoctor/core";
import { categoryPaths } from "./pages";

/** `"all-crawled"` = every crawled HTML page (200 responses) of the site. */
export type ExpectedPages = string[] | "all-crawled";

export interface ExpectedIssue {
  ruleId: string;
  pages: ExpectedPages;
  severity: Severity;
  verdict: Verdict;
  unverifiedReason?: UnverifiedReason;
  viewport: Viewport;
  /** Why this defect exists in Broken Shop (for humans and docs). */
  note: string;
}

export interface ExpectedScenario {
  id: string;
  description: string;
  /** Setup the test harness applies via the `/__demo/*` control endpoints. */
  steps: string[];
  expect: string;
}

export interface ExpectedManifest {
  schemaVersion: 1;
  /** Port-independent: paths are relative to the site origin. */
  modes: Record<"broken" | "fixed", { issues: ExpectedIssue[] }>;
  scenarios: ExpectedScenario[];
}

const externalUnverified: ExpectedIssue = {
  ruleId: "link.external.broken",
  pages: ["/about"],
  severity: "medium",
  verdict: "unverified",
  unverifiedReason: "rate_limited",
  viewport: "all",
  note: "External site answers 429. Must be reported as unverified, never as broken. Same in fixed mode: the site owner cannot fix it.",
};

export const expectedManifest: ExpectedManifest = {
  schemaVersion: 1,
  modes: {
    broken: {
      issues: [
        {
          ruleId: "nav.page.orphan",
          pages: ["/orphan"],
          severity: "low",
          verdict: "fail",
          viewport: "all",
          note: "Listed only in the sitemap: no page links to it. Fixed mode links it from the footer.",
        },
        {
          ruleId: "res.img.failed",
          pages: ["/products/backpack"],
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "Page is 200 but the main product image is 404 (resource error, not page error).",
        },
        {
          ruleId: "a11y.axe.image-alt",
          pages: ["/products/backpack"],
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "Badge image has no alt attribute.",
        },
        {
          ruleId: "runtime.img.no-dimensions",
          pages: ["/products/backpack"],
          severity: "low",
          verdict: "fail",
          viewport: "all",
          note: "Images without width/height cause layout shift.",
        },
        {
          ruleId: "seo.h1.multiple",
          pages: ["/products/backpack"],
          severity: "low",
          verdict: "fail",
          viewport: "all",
          note: "Two <h1>; low severity / low confidence on purpose.",
        },
        {
          ruleId: "seo.h1.missing",
          pages: categoryPaths,
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "One category template renders no <h1> -> a single Root Cause Group of 18 pages.",
        },
        {
          ruleId: "a11y.axe.label",
          pages: ["/checkout"],
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "Email input without a label.",
        },
        {
          ruleId: "a11y.axe.button-name",
          pages: ["/checkout"],
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "Icon button without an accessible name.",
        },
        {
          ruleId: "a11y.axe.color-contrast",
          pages: ["/checkout"],
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "#aaa on #fff hint text.",
        },
        {
          ruleId: "runtime.console.error",
          pages: ["/cart"],
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "Inline script throws 'Cart init failed'.",
        },
        {
          ruleId: "runtime.overflow-x.mobile",
          pages: ["/size-guide"],
          severity: "medium",
          verdict: "fail",
          viewport: "mobile",
          note: "900px-wide block causes horizontal scrolling on mobile.",
        },
        {
          ruleId: "seo.canonical.invalid",
          pages: ["/about"],
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "Canonical points to /gone (404).",
        },
        {
          ruleId: "seo.description.missing",
          pages: ["/about"],
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "No meta description.",
        },
        {
          ruleId: "link.internal.redirect-chain",
          pages: ["/about"],
          severity: "low",
          verdict: "fail",
          viewport: "all",
          note: "/old -> /old-2 -> /old-3 -> /new-arrivals (3 hops).",
        },
        {
          ruleId: "link.internal.redirect-loop",
          pages: ["/about"],
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "/loop-a <-> /loop-b.",
        },
        {
          ruleId: "link.internal.broken",
          pages: "all-crawled",
          severity: "high",
          verdict: "fail",
          viewport: "all",
          note: "Shared footer links to /missing-page (404) on every page -> one group.",
        },
        {
          ruleId: "res.font.failed",
          pages: "all-crawled",
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "Shared CSS references /fonts/missing.woff2 (404).",
        },
        {
          ruleId: "runtime.resource.heavy",
          pages: "all-crawled",
          severity: "low",
          verdict: "fail",
          viewport: "all",
          note: "/assets/storefront.js is ~450 KB on every page.",
        },
        {
          ruleId: "seo.sitemap.bad-entries",
          pages: ["/sitemap.xml"],
          severity: "medium",
          verdict: "fail",
          viewport: "all",
          note: "Sitemap lists /gone which answers 404.",
        },
        externalUnverified,
      ],
    },
    fixed: { issues: [externalUnverified] },
  },
  scenarios: [
    {
      id: "flaky-down",
      description:
        "A page that was checked successfully in run 1 is unreachable in run 2. Its issues must not become Fixed.",
      steps: ["POST /__demo/flaky/down"],
      expect:
        "/flaky is reported as unverified (503); no issue is marked fixed because of this page.",
    },
    {
      id: "verify-fix",
      description: "Switching the site from broken to fixed and re-verifying single issues.",
      steps: ["POST /__demo/mode/fixed"],
      expect: "Re-verifying any broken-mode issue yields 'Verified fixed' (except external 429).",
    },
  ],
};
