import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  startUrl: text("start_url").notNull(),
  status: text("status").notNull(),
  settings: text("settings", { mode: "json" }).notNull(),
  scannerVersion: text("scanner_version").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  partial: integer("partial", { mode: "boolean" }).notNull(),
  stopReason: text("stop_reason"),
});

export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    url: text("url").notNull(),
    finalUrl: text("final_url").notNull(),
    status: integer("status").notNull(),
    depth: integer("depth").notNull(),
    viewport: text("viewport").notNull(),
    title: text("title"),
    screenshotKey: text("screenshot_key"),
    screenshotTruncated: integer("screenshot_truncated", { mode: "boolean" }).notNull(),
  },
  (t) => [index("pages_run_idx").on(t.runId)],
);

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    ruleId: text("rule_id").notNull(),
    category: text("category").notNull(),
    pageUrl: text("page_url").notNull(),
    viewport: text("viewport").notNull(),
    severity: text("severity").notNull(),
    confidence: real("confidence").notNull(),
    verdict: text("verdict").notNull(),
    unverifiedReason: text("unverified_reason"),
    status: text("status").notNull(),
    title: text("title").notNull(),
    groupId: text("group_id"),
    firstSeenRunId: text("first_seen_run_id").notNull(),
    lastSeenRunId: text("last_seen_run_id").notNull(),
    /** Heavy parts: evidence, explanation, fix, statusHistory. */
    data: text("data", { mode: "json" }).notNull(),
  },
  (t) => [index("issues_run_idx").on(t.runId), index("issues_fingerprint_idx").on(t.fingerprint)],
);

export const issueGroups = sqliteTable(
  "issue_groups",
  {
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    ruleId: text("rule_id").notNull(),
    signature: text("signature").notNull(),
    hypothesis: integer("hypothesis", { mode: "boolean" }).notNull(),
    confidence: real("confidence").notNull(),
    affectedPages: integer("affected_pages").notNull(),
    issueIds: text("issue_ids", { mode: "json" }).notNull(),
  },
  (t) => [index("groups_run_idx").on(t.runId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    issueId: text("issue_id").notNull(),
    outcome: text("outcome").notNull(),
    checkedAt: text("checked_at").notNull(),
    data: text("data", { mode: "json" }).notNull(),
  },
  (t) => [index("verifications_run_idx").on(t.runId, t.issueId)],
);
