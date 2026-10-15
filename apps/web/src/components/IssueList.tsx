import type { Issue } from "@webdoctor/core/shared";
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
}

function Row({
  issue,
  selected,
  title,
  meta,
  onSelect,
  onHover,
}: {
  issue: Issue;
  selected: boolean;
  title: string;
  meta: string;
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
        {issue.verdict === "unverified" && <span className="tag warn">?</span>}
      </button>
    </li>
  );
}

export function IssueList({ items, selectedKey, onSelect, onHover }: Props) {
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
            onSelect={() => onSelect(item.key)}
            onHover={onHover}
          />
        ),
      )}
    </ul>
  );
}
