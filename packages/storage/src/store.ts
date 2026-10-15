import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { ReportSchema, SCHEMA_VERSION } from "@webdoctor/core";
import type { Issue, IssueGroup, PageSummary, Report, Run } from "@webdoctor/core";
import { migrate } from "./migrate";
import { issueGroups, issues, pages, runs } from "./schema";

type IssueData = Pick<Issue, "evidence" | "explanation" | "fix" | "statusHistory">;

export interface RunListItem {
  id: string;
  startUrl: string;
  status: string;
  startedAt: string;
  partial: boolean;
}

export interface Store {
  /** Saves a whole report atomically (replaces a run with the same id). */
  saveReport(report: Report): void;
  getReport(runId: string): Report | undefined;
  listRuns(): RunListItem[];
  close(): void;
}

/** Opens (and migrates) a SQLite store. Use `":memory:"` in tests. */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
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
    listRuns: () =>
      db
        .select({
          id: runs.id,
          startUrl: runs.startUrl,
          status: runs.status,
          startedAt: runs.startedAt,
          partial: runs.partial,
        })
        .from(runs)
        .orderBy(desc(runs.startedAt))
        .all(),
    close: () => sqlite.close(),
  };
}
