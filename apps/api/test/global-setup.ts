import pg from 'pg';
import { bootstrapReference } from '../src/platform/bootstrap.js';
import { createPool } from '../src/platform/db.js';
import { migrate, MIGRATIONS_DIR } from '../src/platform/migrate.js';

/** Real PostgreSQL only (no SQLite/in-memory fakes — T094). Fresh database per run. */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const dbName = process.env.TEST_DB_NAME ?? 'om_test';
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
  const url = admin.replace(/\/[^/]*$/, `/${dbName}`);
  process.env.TEST_DATABASE_URL = url;
  const db = createPool(url, 2);
  await migrate(db, MIGRATIONS_DIR);
  await bootstrapReference(db);
  await db.end();
  return async () => undefined;
}
