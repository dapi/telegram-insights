import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// bigint columns come back as strings by default; ids here fit into JS numbers
// only for message ids, so keep bigint as string and convert explicitly.
pg.types.setTypeParser(20, (value) => value);

export function createPool(connectionString, { max = 4, applicationName = 'telegram-insights' } = {}) {
  if (!connectionString) {
    throw new Error('PostgreSQL connection string is not configured');
  }
  return new pg.Pool({ connectionString, max, application_name: applicationName });
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

export async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['telegram-insights:migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS public.ti_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM public.ti_schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const done = [];
    for (const migration of listMigrations()) {
      // Grants are re-applied every time so that new tables reach existing roles.
      const repeatable = migration.name.endsWith('_grants.sql');
      if (applied.has(migration.name) && !repeatable) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.ti_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET applied_at = now()',
          [migration.name],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${migration.name} failed: ${error.message}`);
      }
      if (!applied.has(migration.name)) {
        done.push(migration.name);
        log(`applied ${migration.name}`);
      }
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['telegram-insights:migrate']).catch(() => {});
    client.release();
  }
}
