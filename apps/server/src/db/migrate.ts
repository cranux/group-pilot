import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { hashPassword } from '../auth/passwords.js';

const MIGRATIONS_LOCK = 0x67700002;

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((file) => ({
      version: Number(file.split('_')[0]),
      name: file.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(dir, file), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
}

/** 代码期望的 schema 版本 = 随代码发布的最新迁移号 */
export function expectedSchemaVersion(dir = MIGRATIONS_DIR): number {
  const all = loadMigrations(dir);
  return all.length ? all[all.length - 1].version : 0;
}

export async function currentSchemaVersion(pool: pg.Pool): Promise<number | null> {
  const exists = await pool.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!exists.rows[0].t) return null;
  const res = await pool.query(`SELECT coalesce(max(version), 0) AS v FROM schema_migrations`);
  return Number(res.rows[0].v);
}

/**
 * 执行全部未应用的迁移并写入种子数据。可重复执行：已应用的跳过，种子用 ON CONFLICT DO NOTHING。
 * advisory lock 保证多个进程同时执行时串行。
 */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => undefined): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const applied = new Set(
      (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    for (const m of loadMigrations()) {
      if (applied.has(m.version)) continue;
      log(`applying migration ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await seed(client);
    const res = await client.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations');
    return Number(res.rows[0].v);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK]).catch(() => undefined);
    client.release();
  }
}

export const SEED_ACCOUNT_IDS = Array.from({ length: 8 }, (_, i) => `acc-${String(i + 1).padStart(2, '0')}`);

async function seed(client: pg.PoolClient): Promise<void> {
  const users: Array<[string, string, 'admin' | 'viewer']> = [
    ['admin', 'admin', 'admin'],
    ['viewer', 'viewer', 'viewer'],
  ];
  for (const [username, password, role] of users) {
    const exists = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists.rowCount) continue;
    await client.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING`,
      [username, await hashPassword(password), role],
    );
  }
  await client.query(
    `INSERT INTO accounts (id) SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING`,
    [SEED_ACCOUNT_IDS],
  );
}
