import { createClient } from '@libsql/client/web';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function openDatabase({ dbPath = join(process.cwd(), 'data/cards.sqlite'), databaseUrl = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN } = {}) {
  let db;
  if (databaseUrl) {
    db = createClient({ url: databaseUrl, authToken });
  } else {
    if (process.env.VERCEL) throw new Error('set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in vercel.');
    const { DatabaseSync } = await import('node:sqlite');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec('PRAGMA journal_mode = WAL');
    const execute = statement => {
      const { sql, args = [] } = typeof statement === 'string' ? { sql: statement } : statement;
      return { rows: sqlite.prepare(sql).all(...args) };
    };
    db = {
      execute: async statement => execute(statement),
      batch: async statements => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map(execute);
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
      close: () => sqlite.close(),
    };
  }
  await db.batch([
    'CREATE TABLE IF NOT EXISTS accounts (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS cards (slug TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS cards_owner ON cards(owner)',
    'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  ], 'write');
  return db;
}
