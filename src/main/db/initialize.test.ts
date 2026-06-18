import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as InitializeModule from './initialize';

vi.mock('./client', () => ({
  sqlite: {},
}));

type MigrationRow = { hash: string; created_at: number };

class FakeConnection {
  migrations: MigrationRow[] = [];
  tables = new Map<string, Set<string>>();

  exec(sql: string): void {
    const createTable = /^CREATE TABLE(?: IF NOT EXISTS)?\s+[`"]?([A-Za-z0-9_]+)[`"]?/i.exec(sql);
    if (createTable) {
      this.tables.set(createTable[1], this.tables.get(createTable[1]) ?? new Set());
      return;
    }

    const alterTable =
      /^ALTER TABLE\s+[`"]?([A-Za-z0-9_]+)[`"]?\s+ADD\s+[`"]?([A-Za-z0-9_]+)[`"]?\s+/i.exec(sql);
    if (alterTable) {
      const [, tableName, columnName] = alterTable;
      const columns = this.tables.get(tableName) ?? new Set<string>();
      if (columns.has(columnName)) {
        throw new Error(`duplicate column name: ${columnName}`);
      }
      columns.add(columnName);
      this.tables.set(tableName, columns);
    }
  }

  transaction<T>(fn: () => T): () => T {
    return fn;
  }

  prepare(sql: string): {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => void;
  } {
    return {
      get: (...args: unknown[]) => {
        if (sql.includes('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC')) {
          return [...this.migrations].sort((a, b) => b.created_at - a.created_at)[0];
        }
        if (sql.includes('SELECT 1 FROM __drizzle_migrations WHERE hash = ?')) {
          return this.migrations.some((row) => row.hash === args[0]) ? { 1: 1 } : undefined;
        }
        if (sql.includes('SELECT 1 FROM __drizzle_migrations WHERE created_at = ?')) {
          return this.migrations.some((row) => row.created_at === args[0]) ? { 1: 1 } : undefined;
        }
        if (sql.includes('SELECT created_at FROM __drizzle_migrations WHERE created_at =')) {
          const createdAt =
            typeof args[0] === 'number'
              ? args[0]
              : Number(/WHERE created_at = (\d+)/.exec(sql)?.[1] ?? Number.NaN);
          return this.migrations.find((row) => row.created_at === createdAt);
        }
        if (
          sql.includes("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sample'")
        ) {
          return this.tables.has('sample') ? { name: 'sample' } : undefined;
        }
        if (
          sql.includes("SELECT COUNT(*) AS count FROM pragma_table_info('projects') WHERE name = '")
        ) {
          const columnName = /WHERE name = '([^']+)'/.exec(sql)?.[1];
          return {
            count: columnName && this.tables.get('projects')?.has(columnName) ? 1 : 0,
          };
        }
        return undefined;
      },
      all: () => {
        if (sql.includes('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')) {
          return [...this.migrations]
            .sort((a, b) => a.created_at - b.created_at)
            .map(({ created_at }) => ({ created_at }));
        }
        if (sql.includes('PRAGMA table_info')) {
          const tableName = /PRAGMA table_info\([`"]?([A-Za-z0-9_]+)[`"]?\)/i.exec(sql)?.[1];
          return [...(this.tables.get(tableName ?? '') ?? [])].map((name) => ({
            name,
          }));
        }
        return [];
      },
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO __drizzle_migrations')) {
          this.migrations.push({
            hash: String(args[0]),
            created_at: Number(args[1]),
          });
        }
      },
    };
  }
}

let runBundledMigrations: typeof InitializeModule.runBundledMigrations;

beforeAll(async () => {
  ({ runBundledMigrations } = await import('./initialize'));
});

describe('runBundledMigrations', () => {
  it('backfills the canonical journal row when the hash already exists', () => {
    const db = new FakeConnection();
    const sql = 'CREATE TABLE sample (id TEXT PRIMARY KEY);';
    const hash = createHash('sha256').update(sql).digest('hex');
    db.migrations.push({ hash, created_at: 5 });

    runBundledMigrations(db as never, {
      journalEntries: [{ idx: 0, when: 10, tag: 'custom', breakpoints: true }],
      bundledSqlFiles: { 'custom.sql': sql },
    });

    expect(
      db.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at').all()
    ).toEqual([{ created_at: 5 }, { created_at: 10 }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sample'").get()
    ).toBeUndefined();
  });

  it('treats already-present added columns as applied and records the migration', () => {
    const db = new FakeConnection();
    db.tables.set('projects', new Set(['id', 'name', 'archived', 'icon', 'icon_color']));

    const sql = [
      'ALTER TABLE `projects` ADD `archived` integer DEFAULT false NOT NULL;',
      'ALTER TABLE `projects` ADD `icon` text;',
      'ALTER TABLE `projects` ADD `icon_color` text;',
    ].join('--> statement-breakpoint');

    runBundledMigrations(db as never, {
      journalEntries: [{ idx: 0, when: 10, tag: 'projects_additions', breakpoints: true }],
      bundledSqlFiles: { 'projects_additions.sql': sql },
    });

    expect(
      db.prepare('SELECT created_at FROM __drizzle_migrations WHERE created_at = 10').get()
    ).toEqual(expect.objectContaining({ created_at: 10 }));
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM pragma_table_info('projects') WHERE name = 'archived'`
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('projects') WHERE name = 'icon'`)
        .get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM pragma_table_info('projects') WHERE name = 'icon_color'`
        )
        .get()
    ).toEqual({ count: 1 });
  });
});
