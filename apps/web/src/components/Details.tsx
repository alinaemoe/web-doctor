import { useState } from "react";
import type { Evidence, Issue } from "@webdoctor/core/shared";
import { pathOf, priorityOf } from "../lib/model";
import type { Model } from "../lib/model";
import { t, unverifiedReasons } from "../lib/strings";
import type { ListItem } from "../lib/filters";

function useCopy() {
  const [done, setDone] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(id);
      window.setTimeout(() => setDone((d) => (d === id ? null : d)), 1500);
    } catch {
      setDone(null);
    }
  };
  return { done, copy };
}

function EvidenceView({ e }: { e: Evidence }) {
  switch (e.type) {
    case "dom":
      return (
        <>
          <p className="ev-title">DOM element</p>
          <code className="inline">{e.selector}</code>
          <pre>{e.htmlSnippet}</pre>
        </>
      );
    case "network":
      return (
        <>
          <p className="ev-title">Network</p>
          <pre>
            {[
              `${e.method} ${e.requestUrl}`,
              e.status !== undefined ? `status: ${e.status}` : null,
              e.errorText ? `error: ${e.errorText}` : null,
              e.redirectChain?.length ? `redirects: ${e.redirectChain.join(" → ")}` : null,
              e.sizeBytes !== undefined ? `size: ${Math.round(e.sizeBytes / 1024)} KB` : null,
            ]
              .filter(Boolean)
              .join("\n")}
          </pre>
        </>
      );
    case "console":
      return (
        <>
          <p className="ev-title">Console ({e.level})</p>
          <pre>{e.text + (e.source ? `\n${e.source}` : "")}</pre>
        </>
      );
    case "metric":
      return (
        <>
          <p className="ev-title">Measurement</p>
          <pre>{`${e.name}: ${e.value} ${e.unit} (threshold ${e.threshold} ${e.unit})`}</pre>
        </>
      );
    case "headers":
      return (
        <>
          <p className="ev-title">Header</p>
          <pre>{`${e.name}: ${e.value}`}</pre>
        </>
      );
    case "screenshot":
      return <p className="ev-title">Screenshot {e.key}</p>;
  }
}

export function IssueDetails({ issue, model }: { issue: Issue; model: Model }) {
  const { done, copy } = useCopy();
  const p = priorityOf(issue, model);
  const dom = issue.evidence.find((e) => e.type === "dom");
  const x = issue.explanation;

  return (
    <article className="details" aria-label="Issue details">
      <header>
        <div className="badges">
          <span className={`pill sev-${issue.severity}`}>{issue.severity}</span>
          <span className="pill">{issue.category}</span>
          <span className="pill">{Math.round(issue.confidence * 100)}% confidence</span>
          <span className="pill">{issue.viewport}</span>
        </div>
        <h2>{issue.title}</h2>
        <p className="muted mono">
          {issue.ruleId} · {pathOf(issue.pageUrl)}
        </p>
      </header>

      {issue.verdict === "unverified" && (
        <p className="notice warn">
          <strong>{t.unverified}.</strong> {unverifiedReasons[issue.unverifiedReason ?? ""] ?? ""}{" "}
          {t.unverifiedNote}
        </p>
      )}

      <dl className="explain">
        <dt>{t.whatLabel}</dt>
        <dd>{x.what}</dd>
        <dt>{t.whereLabel}</dt>
        <dd>{x.where}</dd>
        <dt>{t.whyLabel}</dt>
        <dd>{x.why}</dd>
        <dt>{t.fixLabel}</dt>
        <dd>
          {x.howToFix}
          {issue.fix?.docsUrl && (
            <>
              {" "}
              <a href={issue.fix.docsUrl} target="_blank" rel="noopener noreferrer">
                Documentation
              </a>
            </>
          )}
        </dd>
        {issue.fix?.after && (
          <>
            <dt>{t.exampleLabel}</dt>
            <dd>
              <pre>{issue.fix.after}</pre>
            </dd>
          </>
        )}
        {issue.fix?.verifyCriterion && (
          <>
            <dt>{t.verifyLabel}</dt>
            <dd>{issue.fix.verifyCriterion}</dd>
          </>
        )}
      </dl>

      {issue.category === "accessibility" && <p className="muted small">{t.a11yNote}</p>}

      <div className="actions">
        {dom && (
          <button type="button" className="btn" onClick={() => copy("sel", dom.selector)}>
            {done === "sel" ? t.copied : t.copySelector}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => copy("json", JSON.stringify(issue, null, 2))}
        >
          {done === "json" ? t.copied : t.copyJson}
        </button>
      </div>

      <h3>
        {t.evidence} ({issue.evidence.length})
      </h3>
      {issue.evidence.map((e, i) => (
        <div className="evidence" key={i}>
          <EvidenceView e={e} />
        </div>
      ))}

      <details className="why-priority">
        <summary>{t.priority}</summary>
        <p className="mono small">
          {p.severityWeight} (severity) × {p.confidence} (confidence) ×{" "}
          {p.affectedPagesFactor.toFixed(2)} (1 + log2 of affected pages) ={" "}
          <strong>{p.score}</strong>
        </p>
      </details>
    </article>
  );
}

export function GroupDetails({
  item,
  model,
  onSelectIssue,
}: {
  item: Extract<ListItem, { kind: "group" }>;
  model: Model;
  onSelectIssue: (id: string) => void;
}) {
  const rep = item.representative;
  const byPage = new Map<string, Issue>();
  for (const m of item.members) if (!byPage.has(m.pageUrl)) byPage.set(m.pageUrl, m);

  return (
    <article className="details" aria-label="Group details">
      <header>
        <div className="badges">
          <span className={`pill sev-${rep.severity}`}>{rep.severity}</span>
          <span className="pill">{t.rootCause}</span>
          <span className="pill">
            {t.hypothesis} · {Math.round(item.group.confidence * 100)}%
          </span>
        </div>
        <h2>
          {rep.title} — {item.pages} pages
        </h2>
        <p className="muted mono">{item.group.ruleId}</p>
      </header>

      <p>
        {item.members.length} occurrences share the same signature, so one shared cause (a template,
        a component or a resource) is likely. This is a hypothesis: fix one page and re-check before
        assuming the others are fixed.
      </p>
      <p className="mono small">{item.group.signature.split("|").slice(2).join("|")}</p>

      <dl className="explain">
        <dt>{t.whyLabel}</dt>
        <dd>{rep.explanation.why}</dd>
        <dt>{t.fixLabel}</dt>
        <dd>{rep.explanation.howToFix}</dd>
      </dl>

      <h3>
        {t.affectedPages} ({byPage.size})
      </h3>
      <ul className="page-list">
        {[...byPage.entries()].map(([url, issue]) => (
          <li key={url}>
            <button type="button" className="link-btn" onClick={() => onSelectIssue(issue.id)}>
              {pathOf(url)}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">Total scanned pages: {model.pageUrls.length}</p>
    </article>
  );
}
