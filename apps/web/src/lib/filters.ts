import type { Category, Issue, IssueGroup, Severity } from "@webdoctor/core/shared";
import { priorityOf, SEVERITY_ORDER } from "./model";
import type { Model } from "./model";

export interface Filters {
  /** Empty = no restriction. */
  categories: Category[];
  severities: Severity[];
  verdict: "fail" | "unverified" | "all";
  viewport: "all" | "desktop" | "mobile";
  /** Exact page URL, "" = all pages. */
  page: string;
  query: string;
  grouped: boolean;
}

export const defaultFilters: Filters = {
  categories: [],
  severities: [],
  verdict: "fail",
  viewport: "all",
  page: "",
  query: "",
  grouped: true,
};

export function applyFilters(issues: Issue[], f: Filters): Issue[] {
  const q = f.query.trim().toLowerCase();
  return issues.filter((i) => {
    if (f.categories.length && !f.categories.includes(i.category)) return false;
    if (f.severities.length && !f.severities.includes(i.severity)) return false;
    if (f.verdict !== "all" && i.verdict !== f.verdict) return false;
    // An issue seen on both viewports ("all") matches either viewport filter.
    if (f.viewport !== "all" && i.viewport !== "all" && i.viewport !== f.viewport) return false;
    if (f.page && i.pageUrl !== f.page) return false;
    if (q) {
      const dom = i.evidence.find((e) => e.type === "dom");
      const haystack = [i.title, i.ruleId, i.pageUrl, i.explanation.what, dom?.selector ?? ""]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export type ListItem =
  | { kind: "issue"; key: string; issue: Issue; score: number }
  | {
      kind: "group";
      key: string;
      group: IssueGroup;
      members: Issue[];
      representative: Issue;
      pages: number;
      score: number;
    };

const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);

/** Builds the left-hand list: root-cause groups (when enabled) plus single issues, by priority. */
export function buildList(issues: Issue[], model: Model, grouped: boolean): ListItem[] {
  const items: ListItem[] = [];
  const byGroup = new Map<string, Issue[]>();

  for (const issue of issues) {
    const group = issue.groupId ? model.groupsById.get(issue.groupId) : undefined;
    if (grouped && group) byGroup.set(group.id, [...(byGroup.get(group.id) ?? []), issue]);
    else
      items.push({
        kind: "issue",
        key: `issue:${issue.id}`,
        issue,
        score: priorityOf(issue, model).score,
      });
  }

  for (const [groupId, members] of byGroup) {
    const group = model.groupsById.get(groupId)!;
    const pages = new Set(members.map((m) => m.pageUrl)).size;
    const representative = [...members].sort((a, b) => rank(a.severity) - rank(b.severity))[0]!;
    if (members.length < 2) {
      // Filtering left a single member: show it as a plain issue.
      items.push({
        kind: "issue",
        key: `issue:${representative.id}`,
        issue: representative,
        score: priorityOf(representative, model).score,
      });
      continue;
    }
    const base = priorityOf(representative, model);
    items.push({
      kind: "group",
      key: `group:${groupId}`,
      group,
      members,
      representative,
      pages,
      // same formula as single issues, but with the pages that are still visible
      score: Math.round(base.severityWeight * base.confidence * (1 + Math.log2(pages)) * 100) / 100,
    });
  }

  return items.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
