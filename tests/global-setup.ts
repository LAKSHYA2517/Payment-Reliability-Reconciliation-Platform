import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { testDatabaseUrl } from "./helpers/test-db";

// Runs once before all test files: create the test database if needed, migrate it, empty it.
export default async function setup(): Promise<void> {
  const testUrl = testDatabaseUrl();
  const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));

  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error("Cannot reach Postgres for tests. Is it running? Try `docker compose up -d db`.", { cause: err });
  }
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    // CREATE DATABASE cannot take a $1 parameter, so the name is quoted as an identifier instead.
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: testUrl,
    dir: "migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });

  const db = new Client({ connectionString: testUrl });
  await db.connect();
  try {
    await db.query("TRUNCATE payments");
  } finally {
    await db.end();
  }
}
