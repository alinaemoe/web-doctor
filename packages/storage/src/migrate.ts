import type Database from "better-sqlite3";

/**
 * Hand-written migrations, kept next to the Drizzle schema (schema.ts) and guarded by
 * `PRAGMA user_version`. Add a new entry to the end for every schema change; never edit old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    start_url TEXT NOT NULL,
    status TEXT NOT NULL,
    settings TEXT NOT NULL,
    scanner_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    partial INTEGER NOT NULL,
    stop_reason TEXT
  );
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    url TEXT NOT NULL,
    final_url TEXT NOT NULL,
    status INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    viewport TEXT NOT NULL,
    title TEXT,
    screenshot_key TEXT,
    screenshot_truncated INTEGER NOT NULL
  );
  CREATE INDEX pages_run_idx ON pages (run_id);
  CREATE TABLE issues (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    category TEXT NOT NULL,
    page_url TEXT NOT NULL,
    viewport TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    verdict TEXT NOT NULL,
    unverified_reason TEXT,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    group_id TEXT,
    first_seen_run_id TEXT NOT NULL,
    last_seen_run_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX issues_run_idx ON issues (run_id);
  CREATE INDEX issues_fingerprint_idx ON issues (fingerprint);
  CREATE TABLE issue_groups (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    hypothesis INTEGER NOT NULL,
    confidence REAL NOT NULL,
    affected_pages INTEGER NOT NULL,
    issue_ids TEXT NOT NULL
  );
  CREATE INDEX groups_run_idx ON issue_groups (run_id);
  `,
  // 2: Verify Fix results
  `
  CREATE TABLE verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX verifications_run_idx ON verifications (run_id, issue_id);
  `,
  // 3: sitemap size, for coverage
  `ALTER TABLE runs ADD COLUMN sitemap_urls INTEGER;`,
  // 4: run history (comparison base, per-run numbers, link-check coverage)
  `ALTER TABLE runs ADD COLUMN previous_run_id TEXT;
   ALTER TABLE runs ADD COLUMN summary TEXT;
   ALTER TABLE runs ADD COLUMN external_capped INTEGER;`,
  // 5: runs made by `reanalyze` (not separate scans: they do not take part in history)
  `ALTER TABLE runs ADD COLUMN reanalyzed_from TEXT;`,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const SCHEMA_USER_VERSION = MIGRATIONS.length;
