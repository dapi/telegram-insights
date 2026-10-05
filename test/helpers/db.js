import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { createPool, migrate } from '../../src/db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let adminUrl = process.env.TI_TEST_DATABASE_URL ?? null;

function resolveAdminUrl() {
  if (!adminUrl) {
    adminUrl = execFileSync('sh', [path.join(root, 'scripts', 'test-db.sh')], { encoding: 'utf8' }).trim();
  }
  return adminUrl;
}

// A fresh database per test file; only synthetic data is written.
export async function createTestDatabase() {
  const admin = resolveAdminUrl();
  const name = `ti_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${name}`);
  await adminClient.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 8 });
  await migrate(pool);
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
