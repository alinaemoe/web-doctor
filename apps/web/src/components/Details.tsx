import { useState } from "react";
import type { Evidence, Issue } from "@webdoctor/core/shared";
import { pathOf, priorityOf } from "../lib/model";
import type { Model } from "../lib/model";
import { t, unverifiedReasons } from "../lib/strings";
import type { ListItem } from "../lib/filters";

const CATEGORY_LABEL: Record<string, string> = {
  "links-resources": "Links & resources",
  accessibility: "Accessibility",
  seo: "SEO",
  runtime: "Runtime",
  performance: "Performance",
};

const EVIDENCE_LABEL: Record<Evidence["type"], string> = {
  dom: "page element",
  network: "network request",
  console: "console message",
  metric: "measurement",
  headers: "header",
  screenshot: "screenshot",
};

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
          <p className="ev-title">Page element</p>
          <code className="inline">{e.selector}</code>
          <pre>{e.htmlSnippet}</pre>
        </>
      );
    case "network":
      return (
        <>
          <p className="ev-title">Network request</p>
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

function FixCard({
  howToFix,
  docsUrl,
  example,
  verify,
}: {
  howToFix: string;
  docsUrl?: string;
  example?: string;
  verify?: string;
}) {
  return (
    <section className="fix-card" aria-label={t.fixLabel}>
      <h3>{t.fixLabel}</h3>
      <p>
        {howToFix}
        {docsUrl && (
          <>
            {" "}
            <a href={docsUrl} target="_blank" rel="noopener noreferrer">
              Documentation
            </a>
          </>
        )}
      </p>
      {example && <pre>{example}</pre>}
      {verify && (
        <p className="muted small">
          <strong>{t.verifyLabel}:</strong> {verify}
        </p>
      )}
    </section>
  );
}

export function IssueDetails({ issue, model }: { issue: Issue; model: Model }) {
  const { done, copy } = useCopy();
  const p = priorityOf(issue, model);
  const dom = issue.evidence.find((e) => e.type === "dom");
  const x = issue.explanation;
  const kinds = [...new Set(issue.evidence.map((e) => EVIDENCE_LABEL[e.type]))].join(", ");

  return (
    <article className="details" aria-label="Issue details">
      <header>
        <div className="badges">
          <span className={`pill pill-sev sev-${issue.severity}`}>{issue.severity}</span>
          <span className="pill">{CATEGORY_LABEL[issue.category] ?? issue.category}</span>
          {issue.viewport !== "all" && <span className="pill">{issue.viewport} only</span>}
          <span className="pill">{Math.round(issue.confidence * 100)}% sure</span>
        </div>
        <h2>{issue.title}</h2>
        <p className="lead">{x.what}</p>
        <p className="where mono">{x.where}</p>
      </header>

      {issue.verdict === "unverified" && (
        <p className="notice warn">
          <strong>{t.unverified}.</strong> {unverifiedReasons[issue.unverifiedReason ?? ""] ?? ""}{" "}
          {t.unverifiedNote}
        </p>
      )}

      <FixCard
        howToFix={x.howToFix}
        docsUrl={issue.fix?.docsUrl}
        example={issue.fix?.after}
        verify={issue.fix?.verifyCriterion}
      />

      <section>
        <h3>{t.whyLabel}</h3>
        <p>{x.why}</p>
        {issue.category === "accessibility" && <p className="muted small">{t.a11yNote}</p>}
      </section>

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

      <details className="fold" open={issue.evidence.length <= 2}>
        <summary>
          {t.evidence} ({issue.evidence.length}) — {kinds}
        </summary>
        {issue.evidence.map((e, i) => (
          <div className="evidence" key={i}>
            <EvidenceView e={e} />
          </div>
        ))}
      </details>

      <details className="fold why-priority">
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

const SIGNATURE_LABEL: Record<string, string> = {
  net: "Shared request",
  dom: "Shared element",
  console: "Shared message",
  metric: "Shared measurement",
};

export function GroupDetails({
  item,
  onSelectIssue,
}: {
  item: Extract<ListItem, { kind: "group" }>;
  model: Model;
  onSelectIssue: (id: string) => void;
}) {
  const rep = item.representative;
  const byPage = new Map<string, Issue>();
  for (const m of item.members) if (!byPage.has(m.pageUrl)) byPage.set(m.pageUrl, m);
  const [, kind = "", ...rest] = item.group.signature.split("|");
  const common = rest.join("|");

  return (
    <article className="details" aria-label="Group details">
      <header>
        <div className="badges">
          <span className={`pill pill-sev sev-${rep.severity}`}>{rep.severity}</span>
          <span className="pill">{t.rootCause}</span>
          <span className="pill">
            {t.hypothesis} · {Math.round(item.group.confidence * 100)}%
          </span>
        </div>
        <h2>{rep.title}</h2>
        <p className="lead">
          Found on {byPage.size} pages ({item.members.length} times in total).
        </p>
        <p>
          It most likely comes from one shared place, such as a template, a component or a file.
          This is a hypothesis: fix one page and re-check before assuming the others are fixed.
        </p>
        {common && (
          <p className="where mono">
            {SIGNATURE_LABEL[kind] ?? "Shared signature"}: {common}
          </p>
        )}
      </header>

      <FixCard
        howToFix={rep.explanation.howToFix}
        docsUrl={rep.fix?.docsUrl}
        verify={rep.fix?.verifyCriterion}
      />

      <section>
        <h3>{t.whyLabel}</h3>
        <p>{rep.explanation.why}</p>
      </section>

      <section>
        <h3>
          {t.affectedPages} ({byPage.size})
        </h3>
        <p className="muted small">{t.clickPage}</p>
        <ul className="page-list">
          {[...byPage.entries()].map(([url, issue]) => (
            <li key={url}>
              <button type="button" onClick={() => onSelectIssue(issue.id)}>
                <span>{pathOf(url)}</span>
                <span aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
