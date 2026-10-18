import type { Issue } from "@webdoctor/core/shared";
import { isStale, wasFixedNow } from "../lib/filters";
import type { ListItem } from "../lib/filters";
import { pathOf } from "../lib/model";
import { t } from "../lib/strings";

const SEV_LETTER: Record<string, string> = {
  critical: "C",
  high: "H",
  medium: "M",
  low: "L",
  info: "I",
};

interface Props {
  items: ListItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onHover: (issueId: string | null) => void;
  /** Needed to tell what is new, back or not rechecked in this run. */
  runId: string;
  hasPrevious: boolean;
}

/** Small label for what happened to a problem since the previous run. */
function changeTag(
  issue: Issue,
  runId: string,
  hasPrevious: boolean,
): { text: string; tone: string } | null {
  if (isStale(issue, runId)) return { text: "not rechecked", tone: "muted" };
  if (!hasPrevious) return null;
  if (wasFixedNow(issue, runId)) return { text: "fixed", tone: "ok" };
  if (issue.status === "reopened") return { text: "back", tone: "bad" };
  if (issue.status === "new") return { text: "new", tone: "bad" };
  return null;
}

/** A group is "new" when it has new members; the number says how many. */
function groupTag(
  members: Issue[],
  runId: string,
  hasPrevious: boolean,
): { text: string; tone: string } | null {
  const stale = members.filter((m) => isStale(m, runId)).length;
  if (stale === members.length) return { text: "not rechecked", tone: "muted" };
  if (!hasPrevious) return null;
  const back = members.filter((m) => m.status === "reopened").length;
  const fresh = members.filter((m) => m.status === "new").length;
  if (back > 0) return { text: `${back} back`, tone: "bad" };
  if (fresh > 0) return { text: fresh === members.length ? "new" : `${fresh} new`, tone: "bad" };
  return null;
}

function Row({
  issue,
  selected,
  title,
  meta,
  tag,
  onSelect,
  onHover,
}: {
  issue: Issue;
  selected: boolean;
  title: string;
  meta: string;
  tag?: { text: string; tone: string } | null;
  onSelect: () => void;
  onHover: (id: string | null) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="row"
        data-selected={selected}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onMouseEnter={() => onHover(issue.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(issue.id)}
        onBlur={() => onHover(null)}
      >
        <span className={`sev-badge sev-${issue.severity}`} title={issue.severity}>
          {SEV_LETTER[issue.severity]}
          <span className="sr-only">{issue.severity}</span>
        </span>
        <span className="row-main">
          <span className="row-title">{title}</span>
          <span className="row-meta">{meta}</span>
        </span>
        {tag && <span className={`tag tag-${tag.tone}`}>{tag.text}</span>}
        {issue.verdict === "unverified" && <span className="tag warn">?</span>}
      </button>
    </li>
  );
}

export function IssueList({ items, selectedKey, onSelect, onHover, runId, hasPrevious }: Props) {
  if (items.length === 0) return <p className="empty">{t.noMatches}</p>;
  return (
    <ul className="issue-list" aria-label="Issues">
      {items.map((item) =>
        item.kind === "issue" ? (
          <Row
            key={item.key}
            issue={item.issue}
            selected={selectedKey === item.key}
            title={item.issue.title}
            meta={`${pathOf(item.issue.pageUrl)} · ${item.issue.ruleId}`}
            tag={changeTag(item.issue, runId, hasPrevious)}
            onSelect={() => onSelect(item.key)}
            onHover={onHover}
          />
        ) : (
          <Row
            key={item.key}
            issue={item.representative}
            selected={selectedKey === item.key}
            title={`${item.representative.title} — ${item.pages} pages`}
            meta={`${item.members.length} occurrences · ${item.group.ruleId}`}
            tag={groupTag(item.members, runId, hasPrevious)}
            onSelect={() => onSelect(item.key)}
            onHover={onHover}
          />
        ),
      )}
    </ul>
  );
}
