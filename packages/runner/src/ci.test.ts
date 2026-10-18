import { describe, expect, it } from "vitest";
import type { Issue, Report } from "@webdoctor/core";
import { escapeAnnotation, toAnnotations, toCiSummary } from "./ci";

const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    id: "i",
    title: "Image failed | to load",
    severity: "high",
    confidence: 1,
    pageUrl: "https://x.test/a",
    explanation: { what: "bad\nthing 100%", where: "", why: "", howToFix: "" },
    ...over,
  }) as Issue;

const report = {
  run: {
    settings: { startUrl: "https://x.test/" },
    partial: false,
    previousRunId: "p",
    summary: { new: 2, fixedSinceLast: 1, reopened: 0 },
  },
  pages: [{ url: "https://x.test/" }, { url: "https://x.test/" }, { url: "https://x.test/a" }],
} as unknown as Report;

describe("CI output", () => {
  it("escapes characters that GitHub treats as commands", () => {
    expect(escapeAnnotation("a%b\r\nc")).toBe("a%25b%0D%0Ac");
  });

  it("builds annotations that cannot be broken out of by page text", () => {
    const lines = toAnnotations([issue({ title: "x\n::error::pwn" })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n/);
    expect(lines[0]).toContain("%0A");
    expect(lines[0]!.startsWith("::error title=")).toBe(true);
    expect(toAnnotations([issue({ severity: "low" })])[0]!.startsWith("::warning")).toBe(true);
    expect(toAnnotations(Array(30).fill(issue()))).toHaveLength(10);
  });

  it("summarizes the run in Markdown with a safe table", () => {
    const md = toCiSummary(report, [issue(), issue({ severity: "critical", title: "Worse <b>" })], {
      failOn: "high",
      failed: true,
    });
    expect(md).toContain("❌ failed");
    expect(md).toContain("Scanned **2** pages");
    expect(md).toContain("+2 new, −1 fixed");
    expect(md.indexOf("critical")).toBeLessThan(md.indexOf("| high"));
    expect(md).toContain("Image failed \\| to load");
    expect(md).toContain("Worse &lt;b>");
    expect(toCiSummary(report, [], { failed: false })).toContain("✅ passed");
  });
});
