import type {
  Category,
  Evidence,
  Explanation,
  FixSuggestion,
  ScanResult,
  Severity,
  UnverifiedReason,
  Verdict,
  Viewport,
} from "@webdoctor/core";
import { infoFor } from "./catalog";
import type { RuleInfo } from "./catalog";

/** An issue before it gets an id, fingerprint, status and group. */
export interface IssueDraft {
  ruleId: string;
  category: Category;
  pageUrl: string;
  viewport: Viewport;
  title: string;
  severity: Severity;
  confidence: number;
  verdict: Verdict;
  unverifiedReason?: UnverifiedReason;
  evidence: Evidence[];
  explanation: Explanation;
  fix?: FixSuggestion;
}

export interface SiteContext {
  scan: ScanResult;
  /** Look up a link check by normalized URL. */
  check(url: string): ScanResult["linkChecks"][string] | undefined;
}

interface DraftInput {
  ruleId: string;
  page: { url: string; viewport: Viewport };
  evidence: Evidence[];
  what: string;
  where: string;
  title?: string;
  severity?: Severity;
  confidence?: number;
  verdict?: Verdict;
  unverifiedReason?: UnverifiedReason;
  howToFix?: string;
  before?: string;
  after?: string;
  /** For open-ended rule families (axe) that have no static catalog entry. */
  info?: Pick<RuleInfo, "category" | "why" | "verifyCriterion"> & { docsUrl?: string };
}

/** Builds a draft from the catalog entry plus rule-specific specifics. */
export function makeDraft(input: DraftInput): IssueDraft {
  const known = infoFor(input.ruleId);
  if (!known && !input.info) throw new Error(`Rule ${input.ruleId} is missing from the catalog`);
  const info: RuleInfo = known ?? {
    severity: "medium",
    title: input.ruleId,
    howToFix: "",
    ...input.info!,
  };
  return {
    ruleId: input.ruleId,
    category: info.category,
    pageUrl: input.page.url,
    viewport: input.page.viewport,
    title: input.title ?? info.title,
    severity: input.severity ?? info.severity,
    confidence: input.confidence ?? 1,
    verdict: input.verdict ?? "fail",
    unverifiedReason: input.unverifiedReason,
    evidence: input.evidence,
    explanation: {
      what: input.what,
      where: input.where,
      why: info.why,
      howToFix: input.howToFix ?? info.howToFix,
    },
    fix: {
      before: input.before,
      after: input.after,
      docsUrl: info.docsUrl,
      verifyCriterion: info.verifyCriterion,
    },
  };
}

export function pagePathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
