import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal DB interface so the service can run on real Postgres (pg) or embedded PGlite in dev/tests. */
/** Normalise a DATE column to YYYY-MM-DD whether the driver returned a string or a Date. */
export function isoDate(v: unknown): string {
  if (v == null) return v as any;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run fn in a transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const pg = await import('pg');
  // Return dates as plain YYYY-MM-DD strings, never JS Dates (avoids timezone drift).
  pg.default.types.setTypeParser(1082, (v: string) => v);
  pg.default.types.setTypeParser(1700, (v: string) => Number(v));
  // Small pool by default: serverless instances (Vercel) each hold their own connections.
  // Supabase: its certificate chain is signed by Supabase's own CA, which node-pg's strict sslmode=require check
  // rejects. Keep the connection encrypted but skip CA verification there (the usual setup for Supabase from Node).
  const supabase = /supabase\.(co|com)/.test(connectionString);
  const url = supabase ? connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '') : connectionString;
  const pool = new pg.default.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10), ssl: supabase ? { rejectUnauthorized: false } : undefined });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    query: async <T>(s: string, p?: unknown[]) => (await c.query(s, p)).rows as T[],
    exec: async (s: string) => void (await c.query(s)),
    tx: async () => {
      throw new Error('Nested transactions are not supported');
    },
    close: async () => undefined,
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir, {
    parsers: { [types.DATE]: (v: string) => v, [types.NUMERIC]: (v: string) => Number(v) },
  });
  type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> };
  const wrap = (c: Q): Db => ({
    query: async <T>(s: string, p?: unknown[]) => (await c.query(s, p)).rows as T[],
    exec: async (s: string) => void (await c.exec(s)),
    tx: async (fn) => fn(wrap(c)),
    close: async () => undefined,
  });
  return {
    ...wrap(db as unknown as Q),
    tx: (fn) => db.transaction((t) => fn(wrap(t as unknown as Q))),
    close: () => db.close(),
  };
}

/** Which database: Supabase when its Vercel integration is connected (SUPABASE_POSTGRES_URL), else DATABASE_URL. */
export function databaseUrl(): string | undefined {
  return process.env.EH_DATABASE_URL || process.env.SUPABASE_POSTGRES_URL || process.env.DATABASE_URL || undefined;
}

export async function createDb(): Promise<Db> {
  const url = databaseUrl();
  if (url) return createPgDb(url);
  // Local dev keeps data on disk (apps/api/.pglite-data) so it survives restarts; PGLITE_DIR=memory:// for a throwaway DB.
  return createPgliteDb(process.env.PGLITE_DIR || (process.env.NODE_ENV === 'production' ? undefined : '.pglite-data'));
}

// apps/api/migrations next to src/ in the repo; EH_MIGRATIONS_DIR or ./migrations beside a bundled build (Vercel).
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.EH_MIGRATIONS_DIR ?? (existsSync(join(HERE, "migrations")) ? join(HERE, "migrations") : join(HERE, "..", "migrations"));

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS eh_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM eh_schema_migrations')).map((r) => r.version));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO eh_schema_migrations (version) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
