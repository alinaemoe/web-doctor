import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const CategorySchema = z.enum([
  "links-resources",
  "accessibility",
  "seo",
  "runtime",
  "performance",
]);
export const ViewportSchema = z.enum(["desktop", "mobile", "all"]);

/** `pass` never produces an issue, so only these two verdicts exist on an issue. */
export const VerdictSchema = z.enum(["fail", "unverified"]);

export const StatusSchema = z.enum(["new", "open", "fixed", "reopened", "ignored", "unverified"]);

export const UnverifiedReasonSchema = z.enum([
  "rate_limited",
  "timeout",
  "blocked",
  "dns",
  "needs_manual_review",
  "auth_required",
  "page_unreachable",
]);

export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

/** Data used to re-locate a DOM node after the page changed (see TZ 6.10). */
export const NodeSignatureSchema = z.object({
  id: z.string().optional(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  /** DOM path without indexes of dynamic classes, e.g. `main > form > input`. */
  domPath: z.string().optional(),
  /** Hash of nearby text / structure. */
  contextHash: z.string().optional(),
});

export const EvidenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dom"),
    selector: z.string(),
    xpath: z.string().optional(),
    htmlSnippet: z.string(),
    boundingBox: BoxSchema.optional(),
    nodeSignature: NodeSignatureSchema,
  }),
  z.object({
    type: z.literal("network"),
    requestUrl: z.string(),
    method: z.string(),
    status: z.number().int().optional(),
    redirectChain: z.array(z.string()).optional(),
    resourceType: z.string(),
    sizeBytes: z.number().int().nonnegative().optional(),
    errorText: z.string().optional(),
  }),
  z.object({
    type: z.literal("console"),
    level: z.string(),
    text: z.string(),
    source: z.string().optional(),
  }),
  z.object({
    type: z.literal("screenshot"),
    key: z.string(),
    region: BoxSchema.optional(),
  }),
  z.object({
    type: z.literal("metric"),
    name: z.string(),
    value: z.number(),
    threshold: z.number(),
    unit: z.string(),
  }),
  z.object({
    type: z.literal("headers"),
    name: z.string(),
    value: z.string(),
  }),
]);

/** What / Where / Why it matters / How to fix (TZ 6.6). */
export const ExplanationSchema = z.object({
  what: z.string(),
  where: z.string(),
  why: z.string(),
  howToFix: z.string(),
});

export const FixSuggestionSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  docsUrl: z.string().url().optional(),
  verifyCriterion: z.string(),
});

export const StatusChangeSchema = z.object({
  from: StatusSchema.nullable(),
  to: StatusSchema,
  runId: z.string(),
  at: z.string().datetime(),
  reason: z.string().optional(),
});

export const IssueSchema = z.object({
  id: z.string(),
  runId: z.string(),
  ruleId: z.string(),
  category: CategorySchema,
  pageUrl: z.string(),
  viewport: ViewportSchema,
  title: z.string(),
  severity: SeveritySchema,
  /** 0..1, independent from severity. */
  confidence: z.number().min(0).max(1),
  verdict: VerdictSchema,
  unverifiedReason: UnverifiedReasonSchema.optional(),
  status: StatusSchema,
  /** An issue without evidence must not exist. */
  evidence: z.array(EvidenceSchema).min(1),
  explanation: ExplanationSchema,
  fix: FixSuggestionSchema.optional(),
  fingerprint: z.string(),
  groupId: z.string().optional(),
  firstSeenRunId: z.string(),
  lastSeenRunId: z.string(),
  statusHistory: z.array(StatusChangeSchema),
});

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "completed_with_warnings",
  "failed",
  "canceled",
]);

export const RunSettingsSchema = z.object({
  startUrl: z.string().url(),
  maxPages: z.number().int().positive(),
  maxDepth: z.number().int().nonnegative(),
  viewports: z.array(z.enum(["desktop", "mobile"])).min(1),
  categories: z.array(CategorySchema).min(1),
  respectRobots: z.boolean(),
});

export const RunSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  settings: RunSettingsSchema,
  scannerVersion: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  /** True when the run was canceled or hit a limit before finishing. */
  partial: z.boolean(),
  stopReason: z.enum(["canceled", "timeout", "max-pages"]).optional(),
});

/** Per-page summary kept with a run (for the page list, screenshots, Verify Fix). */
export const PageSummarySchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  status: z.number().int(),
  depth: z.number().int().nonnegative(),
  viewport: z.enum(["desktop", "mobile"]),
  title: z.string().nullable(),
  screenshotKey: z.string().optional(),
  screenshotTruncated: z.boolean(),
});

export const IssueGroupSchema = z.object({
  id: z.string(),
  runId: z.string(),
  ruleId: z.string(),
  /** Common signature shared by the grouped issues (e.g. normalized selector or resource URL). */
  signature: z.string(),
  /** Root causes are hypotheses until verified (TZ 3). */
  hypothesis: z.boolean(),
  confidence: z.number().min(0).max(1),
  issueIds: z.array(z.string()),
  affectedPages: z.number().int().nonnegative(),
});

/** The JSON report format (TZ 6.14); validated in tests and by the CLI. */
export const ReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  run: RunSchema,
  pages: z.array(PageSummarySchema),
  issues: z.array(IssueSchema),
  groups: z.array(IssueGroupSchema),
});

export const VerifyOutcomeSchema = z.enum(["verified-fixed", "still-failing", "unverified"]);

/** Result of re-checking one issue (TZ 6.10). `unverified` never changes an issue to fixed. */
export const VerificationSchema = z.object({
  issueId: z.string(),
  outcome: VerifyOutcomeSchema,
  detail: z.string(),
  checkedAt: z.string().datetime(),
  /** 0..1: how sure the re-check is (lower when the element could not be located). */
  confidence: z.number().min(0).max(1),
  /** The original element was not matched exactly and was found again by its signature. */
  relocated: z.boolean().optional(),
  /** The original element no longer exists on the page (fixed by removal, or the page changed). */
  elementGone: z.boolean().optional(),
  reason: UnverifiedReasonSchema.optional(),
  pages: z.array(
    z.object({
      url: z.string(),
      viewport: z.enum(["desktop", "mobile"]),
      status: z.number().int().optional(),
    }),
  ),
});
