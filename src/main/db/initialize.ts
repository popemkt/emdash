import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import journal from '@root/drizzle/meta/_journal.json';

// Vite bundles all migration SQL files at build time — no runtime path resolution needed.
// Each value is the raw SQL string content of the file.
const sqlFiles = import.meta.glob('@root/drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

function migrationHashExists(connection: BetterSqlite3.Database, hash: string): boolean {
  const row = connection
    .prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1')
    .get(hash) as { 1: number } | undefined;
  return !!row;
}

function migrationTimestampExists(connection: BetterSqlite3.Database, createdAt: number): boolean {
  const row = connection
    .prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1')
    .get(createdAt) as { 1: number } | undefined;
  return !!row;
}

function recordMigration(
  connection: BetterSqlite3.Database,
  hash: string,
  createdAt: number
): void {
  connection
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(hash, createdAt);
}

function hasColumn(
  connection: BetterSqlite3.Database,
  tableName: string,
  columnName: string
): boolean {
  const columns = connection.prepare(`PRAGMA table_info(\`${tableName}\`)`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function isAlreadyAppliedAddColumnStatement(
  connection: BetterSqlite3.Database,
  statement: string
): boolean {
  const match =
    /^ALTER TABLE\s+[`"]?([A-Za-z0-9_]+)[`"]?\s+ADD\s+[`"]?([A-Za-z0-9_]+)[`"]?\s+/i.exec(
      statement
    );
  if (!match) return false;

  const [, tableName, columnName] = match;
  return hasColumn(connection, tableName, columnName);
}

export function runBundledMigrations(
  connection: BetterSqlite3.Database,
  options: {
    journalEntries?: JournalEntry[];
    bundledSqlFiles?: Record<string, string>;
  } = {}
): void {
  const journalEntries = options.journalEntries ?? (journal as { entries: JournalEntry[] }).entries;
  const bundledSqlFiles = options.bundledSqlFiles ?? sqlFiles;

  connection.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const lastRow = connection
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: number } | undefined;
  const lastTimestamp = lastRow?.created_at ?? 0;

  connection.transaction(() => {
    for (const entry of journalEntries) {
      if (entry.when <= lastTimestamp) continue;

      const sqlKey = Object.keys(bundledSqlFiles).find((k) => k.includes(entry.tag));
      if (!sqlKey) throw new Error(`Missing bundled SQL for migration: ${entry.tag}`);

      const sql = bundledSqlFiles[sqlKey];
      const hash = createHash('sha256').update(sql).digest('hex');

      // Older builds could apply the schema change but record a non-journal
      // timestamp. When that happens, treat the migration as already applied
      // and backfill the canonical journal row to keep startup monotonic.
      if (migrationHashExists(connection, hash)) {
        if (!migrationTimestampExists(connection, entry.when)) {
          recordMigration(connection, hash, entry.when);
        }
        continue;
      }

      for (const stmt of sql.split('--> statement-breakpoint')) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        if (isAlreadyAppliedAddColumnStatement(connection, trimmed)) continue;
        connection.exec(trimmed);
      }

      recordMigration(connection, hash, entry.when);
    }
  })();
}

/**
 * Creates the FTS5 full-text search virtual table used by the command palette.
 * This is managed outside the Drizzle migration system because Drizzle cannot
 * generate FTS5 virtual table DDL. The table is version-gated via the `kv`
 * table so it can be safely dropped and recreated when the schema changes.
 */
function ensureSearchIndex(connection: BetterSqlite3.Database): void {
  // Bump this version string whenever the FTS schema changes — the table is
  // dropped and recreated, and backfill() + seedCommands() repopulate it.
  const SEARCH_INDEX_VERSION = '3';

  const row = connection.prepare(`SELECT value FROM kv WHERE key = 'fts_version'`).get() as
    | { value: string }
    | undefined;

  if (row?.value !== SEARCH_INDEX_VERSION) {
    connection.exec(`DROP TABLE IF EXISTS search_index`);
    connection.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        item_type,
        item_id    UNINDEXED,
        project_id UNINDEXED,
        task_id    UNINDEXED,
        title,
        keywords,
        tokenize = 'trigram case_sensitive 0'
      )
    `);
    connection
      .prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('fts_version', ?, unixepoch())`
      )
      .run(SEARCH_INDEX_VERSION);
  }
}

/**
 * Runs all pending migrations against the provided SQLite connection (or the
 * app's shared singleton when called without arguments). Call this once in
 * main.ts before any db queries run.
 *
 * Accepts an explicit connection so migration tests and fixture generators can
 * pass an in-memory database without pulling in the Electron-dependent client
 * module at import time.
 *
 * Returns the connection that was used.
 */
export async function initializeDatabase(
  connection?: BetterSqlite3.Database
): Promise<BetterSqlite3.Database> {
  // Lazily import the app singleton only when no explicit connection is given.
  // This keeps the module importable in non-Electron environments (Vitest).
  const conn = connection ?? (await import('./client')).sqlite;
  runBundledMigrations(conn);
  ensureSearchIndex(conn);
  return conn;
}
