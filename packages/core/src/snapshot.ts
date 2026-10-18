import type { Box, NodeSignature } from "./types";

/**
 * Raw facts collected by the scanner. Rules are pure functions over these types, so they can be
 * tested without a browser. Everything here is JSON-serializable (stored next to the report so a
 * single issue can be re-verified later).
 */

export type ScanViewport = "desktop" | "mobile";

export interface ElementInfo {
  selector: string;
  htmlSnippet: string;
  boundingBox?: Box;
  nodeSignature: NodeSignature;
}

export interface ImageInfo extends ElementInfo {
  /** Resolved absolute URL of `src` (or `currentSrc`). */
  src: string;
  hasAltAttr: boolean;
  hasWidthAttr: boolean;
  hasHeightAttr: boolean;
  naturalWidth: number;
  complete: boolean;
  /** Inside an embedded third-party widget (a map, ...): not something the site owner controls. */
  inWidget?: boolean;
}

export interface LinkInfo extends ElementInfo {
  /** Resolved absolute href. */
  href: string;
  text: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  /** URLs of previous hops, oldest first (empty when not redirected). */
  redirectChain: string[];
  /** Encoded (transferred) body size. */
  sizeBytes?: number;
  errorText?: string;
}

export interface ConsoleEntry {
  level: "error" | "warning" | "pageerror";
  text: string;
  location?: string;
}

export interface AxeNode {
  /** CSS selector (shadow-DOM targets are joined with ` >>> `). */
  target: string;
  html: string;
  failureSummary?: string;
  boundingBox?: Box;
}

export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
}

export interface PageSnapshot {
  /** Normalized URL that was requested. */
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  depth: number;
  viewport: ScanViewport;
  loadedAt: string;
  headers: Record<string, string>;

  title: string | null;
  metaDescription: string | null;
  /** Value of `<link rel=canonical href>` as written (not resolved). */
  canonical: string | null;
  robotsMeta: string | null;
  htmlLang: string | null;

  /** `<main>` (or `<body>`) — evidence for "element is missing" rules. */
  mainElement: ElementInfo | null;
  h1s: ElementInfo[];
  images: ImageInfo[];
  links: LinkInfo[];
  overflowX: { scrollWidth: number; clientWidth: number; offenders: ElementInfo[] };

  network: NetworkEntry[];
  console: ConsoleEntry[];
  axe: AxeViolation[];

  /** For Verify Fix: whether each probed selector still matches an element. */
  probes?: Record<string, boolean>;

  /** Artifact key of the full-page screenshot. */
  screenshotKey?: string;
  fullHeight: number;
  screenshotTruncated: boolean;
}

export type LinkCheckError = "timeout" | "dns" | "network" | "invalid";

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface LinkCheck {
  url: string;
  /** Final URL after following redirects. */
  finalUrl?: string;
  /** Final status (undefined when the request itself failed). */
  status?: number;
  /** Redirect hops followed, in order (empty when there was no redirect). */
  chain: RedirectHop[];
  loop: boolean;
  tooManyHops: boolean;
  error?: LinkCheckError;
  errorText?: string;
  /** The plain request failed, but a real browser loaded it fine (the site blocks scripts). */
  viaBrowser?: boolean;
}

export interface SkippedUrl {
  url: string;
  reason: "robots" | "non-html" | "http-error" | "navigation-error" | "limit" | "external";
  detail?: string;
}

export interface TextResource {
  url: string;
  status?: number;
  text?: string;
  error?: LinkCheckError;
}

export interface ScanResult {
  scannerVersion: string;
  startUrl: string;
  origin: string;
  startedAt: string;
  finishedAt: string;
  /** True when the scan was canceled or hit a time/page limit before the queue was empty. */
  partial: boolean;
  stopReason?: "canceled" | "timeout" | "max-pages";
  pages: PageSnapshot[];
  /** True when external links beyond the cap were not checked. */
  externalLinksCapped?: boolean;
  skipped: SkippedUrl[];
  linkChecks: Record<string, LinkCheck>;
  robots: TextResource;
  sitemap: TextResource & { locs: string[]; declaredInRobots: boolean };
}
