import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, Report } from "@webdoctor/core";
import { migrate } from "./migrate";
import { openStore } from "./store";

function issue(id: string): Issue {
  return {
    id,
    runId: "r1",
    ruleId: "res.img.failed",
    category: "links-resources",
    pageUrl: "http://localhost:4000/p",
    viewport: "all",
    title: "Image failed to load",
    severity: "high",
    confidence: 1,
    verdict: "fail",
    status: "new",
    evidence: [
      {
        type: "network",
        requestUrl: "http://localhost:4000/x.jpg",
        method: "GET",
        status: 404,
        resourceType: "image",
      },
    ],
    explanation: { what: "w", where: "w", why: "w", howToFix: "h" },
    fingerprint: `fp-${id}`,
    firstSeenRunId: "r1",
    lastSeenRunId: "r1",
    statusHistory: [{ from: null, to: "new", runId: "r1", at: "2026-10-16T09:00:00.000Z" }],
  };
}

const report = (): Report => ({
  schemaVersion: SCHEMA_VERSION,
  run: {
    id: "r1",
    status: "completed",
    settings: {
      startUrl: "http://localhost:4000/",
      maxPages: 5,
      maxDepth: 1,
      viewports: ["desktop"],
      categories: ["links-resources"],
      respectRobots: true,
    },
    scannerVersion: "0",
    startedAt: "2026-10-16T09:00:00.000Z",
    partial: false,
  },
  pages: [],
  issues: [issue("a"), issue("b")],
  groups: [],
});

describe("verification persistence", () => {
  it("updates issue status and history and lists verifications oldest first", () => {
    const store = openStore(":memory:");
    store.saveReport(report());

    const fixed: Issue = {
      ...issue("a"),
      status: "fixed",
      statusHistory: [
        ...issue("a").statusHistory,
        {
          from: "new",
          to: "fixed",
          runId: "r1",
          at: "2026-10-16T10:00:00.000Z",
          reason: "Re-verified",
        },
      ],
    };
    store.updateIssues([fixed]);
    store.addVerifications("r1", [
      {
        issueId: "a",
        outcome: "verified-fixed",
        detail: "The check passes on the current page.",
        checkedAt: "2026-10-16T10:00:00.000Z",
        confidence: 1,
        pages: [{ url: "http://localhost:4000/p", viewport: "desktop", status: 200 }],
      },
      {
        issueId: "b",
        outcome: "unverified",
        detail: "page unreachable",
        checkedAt: "2026-10-16T10:01:00.000Z",
        confidence: 0,
        reason: "page_unreachable",
        pages: [],
      },
    ]);

    const loaded = store.getReport("r1")!;
    expect(loaded.issues.find((i) => i.id === "a")).toMatchObject({ status: "fixed" });
    expect(loaded.issues.find((i) => i.id === "a")!.statusHistory).toHaveLength(2);
    expect(loaded.issues.find((i) => i.id === "b")!.status).toBe("new");
    expect(store.listVerifications("r1").map((v) => v.outcome)).toEqual([
      "verified-fixed",
      "unverified",
    ]);
    expect(store.listVerifications("other")).toEqual([]);
    store.close();
  });

  it("migrates an existing v1 database by adding the later tables and columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-mig-"));
    try {
      const db = new Database(join(dir, "old.db"));
      db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 1;");
      migrate(db);
      expect(db.pragma("user_version", { simple: true })).toBe(5);
      expect(db.prepare("select count(*) as n from verifications").get()).toEqual({ n: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
