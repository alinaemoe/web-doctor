import type { Issue, Report } from "@webdoctor/core";

/** GitHub workflow commands treat `%`, CR and LF specially; page text must not break out. */
export function escapeAnnotation(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** `::error` lines for the problems that make the build fail (at most `limit`). */
export function toAnnotations(issues: Issue[], limit = 10): string[] {
  const level = (i: Issue) =>
    i.severity === "critical" || i.severity === "high" ? "error" : "warning";
  return issues.slice(0, limit).map((i) => {
    const title = escapeAnnotation(`${i.title} (${i.severity})`);
    const message = escapeAnnotation(`${i.explanation.what} Page: ${i.pageUrl}`);
    return `::${level(i)} title=${title}::${message}`;
  });
}

const cell = (text: string) =>
  text
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;");

/** Markdown for the GitHub job summary: the numbers, what changed, and the worst problems. */
export function toCiSummary(
  report: Report,
  failing: Issue[],
  options: { failOn?: string; failed: boolean } = { failed: false },
): string {
  const s = report.run.summary;
  const pages = new Set(report.pages.map((p) => p.url)).size;
  const rows = [...failing]
    .sort((a, b) => b.confidence - a.confidence)
    .sort((a, b) => order(b.severity) - order(a.severity))
    .slice(0, 15)
    .map((i) => `| ${i.severity} | ${cell(i.title)} | ${cell(i.pageUrl)} |`);
  const lines = [
    `## Web Doctor: ${options.failed ? "❌ failed" : "✅ passed"}`,
    "",
    `Scanned **${pages}** pages${report.run.partial ? ` (partial: ${report.run.stopReason ?? "limit"})` : ""} of ${cell(report.run.settings.startUrl)}.`,
    `**${failing.length}** failing problems${options.failOn ? `; the build fails on \`${options.failOn}\` and above` : ""}.`,
  ];
  if (report.run.previousRunId && s) {
    lines.push(
      `Since the previous scan: +${s.new} new, −${s.fixedSinceLast} fixed, ${s.reopened} came back.`,
    );
  }
  if (rows.length > 0) {
    lines.push("", "| Severity | Problem | Page |", "| --- | --- | --- |", ...rows);
    if (failing.length > rows.length)
      lines.push("", `…and ${failing.length - rows.length} more in the report.`);
  }
  return lines.join("\n") + "\n";
}

function order(severity: string): number {
  return ["info", "low", "medium", "high", "critical"].indexOf(severity);
}
