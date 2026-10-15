import { priorityScore } from "@webdoctor/core/shared";
import type {
  Issue,
  IssueGroup,
  PageSummary,
  PriorityBreakdown,
  Report,
  Severity,
} from "@webdoctor/core/shared";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface Model {
  report: Report;
  issues: Issue[];
  issuesById: Map<string, Issue>;
  groupsById: Map<string, IssueGroup>;
  pages: PageSummary[];
  /** Distinct page URLs that were scanned, in crawl order. */
  pageUrls: string[];
}

export function buildModel(report: Report): Model {
  return {
    report,
    issues: report.issues,
    issuesById: new Map(report.issues.map((i) => [i.id, i])),
    groupsById: new Map(report.groups.map((g) => [g.id, g])),
    pages: report.pages,
    pageUrls: [...new Set(report.pages.map((p) => p.url))],
  };
}

export function priorityOf(issue: Issue, model: Model): PriorityBreakdown {
  const affected = issue.groupId ? (model.groupsById.get(issue.groupId)?.affectedPages ?? 1) : 1;
  return priorityScore(issue.severity, issue.confidence, affected);
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

export function findPage(
  model: Model,
  url: string,
  viewport: "desktop" | "mobile",
): PageSummary | undefined {
  return model.pages.find((p) => p.url === url && p.viewport === viewport);
}
