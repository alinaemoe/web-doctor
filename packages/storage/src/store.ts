import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq, sql } from "drizzle-orm";
import { ReportSchema, SCHEMA_VERSION, VerificationSchema } from "@webdoctor/core";
import type { Issue, IssueGroup, PageSummary, Report, Run, Verification } from "@webdoctor/core";
import { migrate } from "./migrate";
import { issueGroups, issues, pages, runs, verifications } from "./schema";

type IssueData = Pick<Issue, "evidence" | "explanation" | "fix" | "statusHistory">;

export interface RunListItem {
  id: string;
  startUrl: string;
  status: string;
  startedAt: string;
  partial: boolean;
  /** Issues with verdict "fail". */
  failCount: number;
  /** Issues that could not be verified. */
  unverifiedCount: number;
}

export interface Store {
  /** Saves a whole report atomically (replaces a run with the same id). */
  saveReport(report: Report): void;
  getReport(runId: string): Report | undefined;
  listRuns(): RunListItem[];
  /** Persists changed issues (status and history; the heavy parts are rewritten too). */
  updateIssues(updated: Issue[]): void;
  addVerifications(runId: string, results: Verification[]): void;
  /** Oldest first. */
  listVerifications(runId: string): Verification[];
  close(): void;
}

/** Opens (and migrates) a SQLite store. Use `":memory:"` in tests. */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  // The CLI, the API server and a running scan can all write the same file.
  sqlite.pragma("busy_timeout = 5000");
  migrate(sqlite);
  const db = drizzle(sqlite);

  const saveReport = (report: Report): void => {
    const parsed = ReportSchema.parse(report);
    db.transaction((tx) => {
      const id = parsed.run.id;
      tx.delete(issueGroups).where(eq(issueGroups.runId, id)).run();
      tx.delete(issues).where(eq(issues.runId, id)).run();
      tx.delete(pages).where(eq(pages.runId, id)).run();
      tx.delete(runs).where(eq(runs.id, id)).run();

      tx.insert(runs)
        .values({
          id,
          startUrl: parsed.run.settings.startUrl,
          status: parsed.run.status,
          settings: parsed.run.settings,
          scannerVersion: parsed.run.scannerVersion,
          startedAt: parsed.run.startedAt,
          finishedAt: parsed.run.finishedAt ?? null,
          partial: parsed.run.partial,
          stopReason: parsed.run.stopReason ?? null,
          sitemapUrls: parsed.run.sitemapUrls ?? null,
        })
        .run();

      // SQLite limits bound parameters per statement; insert in chunks.
      const chunk = <T>(rows: T[], size: number) =>
        Array.from({ length: Math.ceil(rows.length / size) }, (_, i) =>
          rows.slice(i * size, (i + 1) * size),
        );

      for (const part of chunk(parsed.pages, 50)) {
        tx.insert(pages)
          .values(part.map((p) => ({ runId: id, ...p, screenshotKey: p.screenshotKey ?? null })))
          .run();
      }
      for (const part of chunk(parsed.issues, 25)) {
        tx.insert(issues)
          .values(
            part.map((i) => ({
              id: i.id,
              runId: i.runId,
              fingerprint: i.fingerprint,
              ruleId: i.ruleId,
              category: i.category,
              pageUrl: i.pageUrl,
              viewport: i.viewport,
              severity: i.severity,
              confidence: i.confidence,
              verdict: i.verdict,
              unverifiedReason: i.unverifiedReason ?? null,
              status: i.status,
              title: i.title,
              groupId: i.groupId ?? null,
              firstSeenRunId: i.firstSeenRunId,
              lastSeenRunId: i.lastSeenRunId,
              data: {
                evidence: i.evidence,
                explanation: i.explanation,
                fix: i.fix,
                statusHistory: i.statusHistory,
              } satisfies IssueData,
            })),
          )
          .run();
      }
      for (const part of chunk(parsed.groups, 50)) {
        tx.insert(issueGroups)
          .values(part.map((g) => ({ ...g, runId: id })))
          .run();
      }
    });
  };

  const getReport = (runId: string): Report | undefined => {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return undefined;

    const runOut: Run = {
      id: run.id,
      status: run.status as Run["status"],
      settings: run.settings as Run["settings"],
      scannerVersion: run.scannerVersion,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? undefined,
      partial: run.partial,
      stopReason: (run.stopReason ?? undefined) as Run["stopReason"],
      sitemapUrls: run.sitemapUrls ?? undefined,
    };
    const pageRows: PageSummary[] = db
      .select()
      .from(pages)
      .where(eq(pages.runId, runId))
      .all()
      .map((p) => ({
        url: p.url,
        finalUrl: p.finalUrl,
        status: p.status,
        depth: p.depth,
        viewport: p.viewport as PageSummary["viewport"],
        title: p.title,
        screenshotKey: p.screenshotKey ?? undefined,
        screenshotTruncated: p.screenshotTruncated,
      }));
    const issueRows: Issue[] = db
      .select()
      .from(issues)
      .where(eq(issues.runId, runId))
      .all()
      .map((i) => {
        const data = i.data as IssueData;
        return {
          id: i.id,
          runId: i.runId,
          ruleId: i.ruleId,
          category: i.category as Issue["category"],
          pageUrl: i.pageUrl,
          viewport: i.viewport as Issue["viewport"],
          title: i.title,
          severity: i.severity as Issue["severity"],
          confidence: i.confidence,
          verdict: i.verdict as Issue["verdict"],
          unverifiedReason: (i.unverifiedReason ?? undefined) as Issue["unverifiedReason"],
          status: i.status as Issue["status"],
          evidence: data.evidence,
          explanation: data.explanation,
          fix: data.fix,
          fingerprint: i.fingerprint,
          groupId: i.groupId ?? undefined,
          firstSeenRunId: i.firstSeenRunId,
          lastSeenRunId: i.lastSeenRunId,
          statusHistory: data.statusHistory,
        };
      });
    const groupRows: IssueGroup[] = db
      .select()
      .from(issueGroups)
      .where(eq(issueGroups.runId, runId))
      .all()
      .map((g) => ({ ...g, issueIds: g.issueIds as string[] }));

    return ReportSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      run: runOut,
      pages: pageRows,
      issues: issueRows,
      groups: groupRows,
    });
  };

  return {
    saveReport,
    getReport,
    listRuns: () => {
      const counts = new Map<string, { fail: number; unverified: number }>();
      const rows = db
        .select({
          runId: issues.runId,
          verdict: issues.verdict,
          n: sql<number>`count(*)`,
        })
        .from(issues)
        .groupBy(issues.runId, issues.verdict)
        .all();
      for (const r of rows) {
        const c = counts.get(r.runId) ?? { fail: 0, unverified: 0 };
        if (r.verdict === "fail") c.fail = r.n;
        else c.unverified += r.n;
        counts.set(r.runId, c);
      }
      return db
        .select({
          id: runs.id,
          startUrl: runs.startUrl,
          status: runs.status,
          startedAt: runs.startedAt,
          partial: runs.partial,
        })
        .from(runs)
        .orderBy(desc(runs.startedAt))
        .all()
        .map((r) => ({
          ...r,
          failCount: counts.get(r.id)?.fail ?? 0,
          unverifiedCount: counts.get(r.id)?.unverified ?? 0,
        }));
    },
    updateIssues: (updated) => {
      db.transaction((tx) => {
        for (const i of updated) {
          tx.update(issues)
            .set({
              status: i.status,
              lastSeenRunId: i.lastSeenRunId,
              data: {
                evidence: i.evidence,
                explanation: i.explanation,
                fix: i.fix,
                statusHistory: i.statusHistory,
              } satisfies IssueData,
            })
            .where(eq(issues.id, i.id))
            .run();
        }
      });
    },
    addVerifications: (runId, results) => {
      if (results.length === 0) return;
      db.transaction((tx) => {
        for (const v of results) {
          const parsed = VerificationSchema.parse(v);
          tx.insert(verifications)
            .values({
              runId,
              issueId: parsed.issueId,
              outcome: parsed.outcome,
              checkedAt: parsed.checkedAt,
              data: parsed,
            })
            .run();
        }
      });
    },
    listVerifications: (runId) =>
      db
        .select()
        .from(verifications)
        .where(eq(verifications.runId, runId))
        .orderBy(verifications.id)
        .all()
        .map((r) => VerificationSchema.parse(r.data)),
    close: () => sqlite.close(),
  };
}
