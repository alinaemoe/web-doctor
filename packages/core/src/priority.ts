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
  score: number;
}

/**
 * `score = severityWeight × confidence × (1 + log2(affectedPages))` (TZ 20, decision 3).
 * Returns the breakdown so the UI can show "Why this priority?".
 */
export function priorityScore(
  severity: Severity,
  confidence: number,
  affectedPages: number,
): PriorityBreakdown {
  const pages = Math.max(1, affectedPages);
  const severityWeight = SEVERITY_WEIGHT[severity];
  const affectedPagesFactor = 1 + Math.log2(pages);
  const clamped = Math.min(1, Math.max(0, confidence));
  return {
    severityWeight,
    confidence: clamped,
    affectedPagesFactor,
    score: Math.round(severityWeight * clamped * affectedPagesFactor * 100) / 100,
  };
}
