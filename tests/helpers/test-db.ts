import { Pool } from "pg";

// Tests always use "<dev database>_test" on the same server, so they can never touch dev data.
export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL is not set. Tests need Postgres: create .env from .env.example and run `docker compose up -d db`.",
    );
  }
  const url = new URL(base);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

export function createTestPool(): Pool {
  return new Pool({ connectionString: testDatabaseUrl(), max: 10 });
}
