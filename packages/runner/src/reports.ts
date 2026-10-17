import { priorityScore } from "@webdoctor/core";
import type { Evidence, Issue, Report } from "@webdoctor/core";

// ---------------------------------------------------------------------------- CSV

/** Cell text comes from scanned sites, so neutralize spreadsheet formulas (CSV injection). */
function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(issues: Issue[]): string {
  const header = [
    "id",
    "ruleId",
    "category",
    "severity",
    "confidence",
    "verdict",
    "unverifiedReason",
    "status",
    "viewport",
    "pageUrl",
    "title",
    "what",
    "selector",
    "requestUrl",
    "groupId",
    "fingerprint",
  ];
  const rows = issues.map((i) => {
    const dom = i.evidence.find((e) => e.type === "dom");
    const net = i.evidence.find((e) => e.type === "network");
    return [
      i.id,
      i.ruleId,
      i.category,
      i.severity,
      i.confidence,
      i.verdict,
      i.unverifiedReason,
      i.status,
      i.viewport,
      i.pageUrl,
      i.title,
      i.explanation.what,
      dom?.selector,
      net?.requestUrl,
      i.groupId,
      i.fingerprint,
    ];
  });
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------- HTML

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export function describeEvidence(e: Evidence): string {
  switch (e.type) {
    case "dom":
      return `Element ${e.selector}\n${e.htmlSnippet}`;
    case "network":
      return [
        `${e.method} ${e.requestUrl}`,
        e.status !== undefined ? `status ${e.status}` : undefined,
        e.errorText ? `error ${e.errorText}` : undefined,
        e.redirectChain?.length ? `via ${e.redirectChain.join(" → ")}` : undefined,
        e.sizeBytes !== undefined ? `${Math.round(e.sizeBytes / 1024)} KB` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
    case "console":
      return `console.${e.level}: ${e.text}${e.source ? ` (${e.source})` : ""}`;
    case "metric":
      return `${e.name} = ${e.value} ${e.unit} (threshold ${e.threshold})`;
    case "headers":
      return `${e.name}: ${e.value}`;
    case "screenshot":
      return `screenshot ${e.key}`;
  }
}

function groupSizes(report: Report): Map<string, number> {
  return new Map(report.groups.map((g) => [g.id, g.affectedPages]));
}

function issueCard(issue: Issue, affectedPages: number): string {
  const score = priorityScore(issue.severity, issue.confidence, affectedPages);
  const fix = issue.fix;
  return `<article class="issue sev-${issue.severity}${issue.verdict === "unverified" ? " unverified" : ""}">
<header>
  <span class="badge">${esc(issue.severity)}</span>
  <span class="badge muted">${esc(issue.category)}</span>
  ${issue.verdict === "unverified" ? `<span class="badge warn">couldn't verify: ${esc(issue.unverifiedReason)}</span>` : ""}
  <h4>${esc(issue.title)}</h4>
  <code>${esc(issue.ruleId)}</code>
</header>
<p class="where">${esc(issue.pageUrl)} · ${esc(issue.viewport)} · confidence ${Math.round(issue.confidence * 100)}% · priority ${score.score}${affectedPages > 1 ? ` · ${affectedPages} pages` : ""}</p>
<dl>
  <dt>What</dt><dd>${esc(issue.explanation.what)}</dd>
  <dt>Where</dt><dd>${esc(issue.explanation.where)}</dd>
  <dt>Why it matters</dt><dd>${esc(issue.explanation.why)}</dd>
  <dt>How to fix</dt><dd>${esc(issue.explanation.howToFix)}${fix?.docsUrl ? ` <a href="${esc(fix.docsUrl)}" rel="noopener noreferrer">docs</a>` : ""}</dd>
  ${fix?.after ? `<dt>Example</dt><dd><pre>${esc(fix.after)}</pre></dd>` : ""}
  ${fix?.verifyCriterion ? `<dt>Fixed when</dt><dd>${esc(fix.verifyCriterion)}</dd>` : ""}
</dl>
<details><summary>Evidence (${issue.evidence.length})</summary>
${issue.evidence.map((e) => `<pre>${esc(describeEvidence(e))}</pre>`).join("\n")}
</details>
</article>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#5b6570;--card:#f6f8fa;--line:#d0d7de;--crit:#b3261e;--high:#c2410c;--med:#a16207;--low:#2563eb;--info:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa4af;--card:#161b22;--line:#30363d;--crit:#ff7b72;--high:#ffa657;--med:#e3b341;--low:#79c0ff;--info:#9aa4af}}
body{margin:0 auto;max-width:960px;padding:24px 16px;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{margin:0 0 4px}h2{margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:4px}
.meta,.where{color:var(--muted);font-size:13px;word-break:break-all}
.cards{display:flex;flex-wrap:wrap;gap:8px}.cards div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
.cards b{display:block;font-size:22px}
.issue{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:8px;padding:12px 14px;margin:10px 0}
.sev-critical{border-left-color:var(--crit)}.sev-high{border-left-color:var(--high)}.sev-medium{border-left-color:var(--med)}.sev-low{border-left-color:var(--low)}
.issue header{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.issue h4{margin:0;flex-basis:100%}
.badge{border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;text-transform:uppercase}.badge.muted{text-transform:none;color:var(--muted)}.badge.warn{border-color:var(--med);color:var(--med);text-transform:none}
dl{display:grid;grid-template-columns:110px 1fr;gap:4px 12px}dt{color:var(--muted)}dd{margin:0}
pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px}
img.shot{max-width:100%;border:1px solid var(--line)}details{margin:6px 0}
.note{border:1px solid var(--med);border-radius:8px;padding:8px 12px}
`;

export interface HtmlReportOptions {
  /** Returns the screenshot bytes for embedding; omitted keys are simply not embedded. */
  screenshot?: (key: string) => Uint8Array | undefined;
}

export function toHtml(report: Report, options: HtmlReportOptions = {}): string {
  const { run } = report;
  const sizes = groupSizes(report);
  const failing = report.issues.filter((i) => i.verdict === "fail");
  const unverified = report.issues.filter((i) => i.verdict === "unverified");
  const bySeverity = (s: string) => failing.filter((i) => i.severity === s).length;
  const byPriority = (a: Issue, b: Issue) =>
    priorityScore(b.severity, b.confidence, sizes.get(b.groupId ?? "") ?? 1).score -
    priorityScore(a.severity, a.confidence, sizes.get(a.groupId ?? "") ?? 1).score;

  const groupsHtml = report.groups.length
    ? report.groups
        .map((g) => {
          const sample = report.issues.find((i) => i.groupId === g.id);
          return `<article class="issue sev-${esc(sample?.severity ?? "info")}">
<h4>${esc(sample?.title ?? g.ruleId)} — ${g.affectedPages} pages, ${g.issueIds.length} occurrences</h4>
<p class="where">Probable common cause (hypothesis, confidence ${Math.round(g.confidence * 100)}%): <code>${esc(g.signature.split("|").slice(2).join("|"))}</code></p>
</article>`;
        })
        .join("\n")
    : "<p>No repeated problems were detected.</p>";

  const shots = report.pages
    .filter((p) => p.viewport === "desktop" && p.screenshotKey)
    .map((p) => {
      const bytes = options.screenshot?.(p.screenshotKey!);
      if (!bytes) return "";
      const data = Buffer.from(bytes).toString("base64");
      return `<details><summary>${esc(p.url)}${p.screenshotTruncated ? " (truncated)" : ""}</summary><img class="shot" alt="Screenshot of ${esc(p.url)}" src="data:image/webp;base64,${data}"></details>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Doctor report — ${esc(run.settings.startUrl)}</title><style>${CSS}</style></head>
<body>
<h1>Web Doctor report</h1>
<p class="meta">${esc(run.settings.startUrl)} · run ${esc(run.id)} · ${esc(run.startedAt)} · ${report.pages.length} page snapshots · scanner ${esc(run.scannerVersion)}</p>
${run.partial ? `<p class="note">Partial result (${esc(run.stopReason ?? "incomplete")}): not every page was scanned.</p>` : ""}
<div class="cards">
${SEVERITY_ORDER.map((s) => `<div><b>${bySeverity(s)}</b>${s}</div>`).join("")}
<div><b>${unverified.length}</b>couldn't verify</div>
</div>
<p class="meta">Automated checks cover only part of accessibility (WCAG); manual testing is still required. “Runtime diagnostics” are basic measurements, not a full performance audit.</p>
<h2>Root cause groups</h2>
${groupsHtml}
<h2>Issues (${failing.length})</h2>
${
  failing
    .sort(byPriority)
    .map((i) => issueCard(i, sizes.get(i.groupId ?? "") ?? 1))
    .join("\n") || "<p>No issues found.</p>"
}
<h2>Couldn't verify (${unverified.length})</h2>
<p class="meta">These checks gave no reliable result (rate limits, blocking, timeouts). They are not necessarily broken.</p>
${unverified.map((i) => issueCard(i, 1)).join("\n") || "<p>Nothing to report.</p>"}
<h2>Screenshots</h2>
${shots || "<p>No screenshots embedded.</p>"}
</body></html>
`;
}
