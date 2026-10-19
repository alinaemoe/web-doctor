import type { Severity } from "./types";

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
  info: 2,
};

export interface PriorityBreakdown {
  severityWeight: number;
  confidence: number;
  affectedPagesFactor: number;
  /** 1 for a page nobody links to, up to 2 for a page that many pages link to. */
  importanceFactor: number;
  score: number;
}

/**
 * `score = severityWeight × confidence × (1 + log2(affectedPages)) × importance` (TZ 20, decision 3);
 * importance grows with the number of pages that link to the page with the problem.
 * Returns the breakdown so the UI can show "Why this priority?".
 */
export function priorityScore(
  severity: Severity,
  confidence: number,
  affectedPages: number,
  inboundLinks = 0,
): PriorityBreakdown {
  const pages = Math.max(1, affectedPages);
  const severityWeight = SEVERITY_WEIGHT[severity];
  const affectedPagesFactor = 1 + Math.log2(pages);
  const clamped = Math.min(1, Math.max(0, confidence));
  // a problem on a page that 64+ pages link to counts twice as much as on a page nobody links to
  const importanceFactor = 1 + Math.min(1, Math.log2(1 + Math.max(0, inboundLinks)) / 6);
  return {
    severityWeight,
    confidence: clamped,
    affectedPagesFactor,
    importanceFactor,
    score:
      Math.round(severityWeight * clamped * affectedPagesFactor * importanceFactor * 100) / 100,
  };
}
