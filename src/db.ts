import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });

  // Without this listener an error on an idle client would crash the process.
  pool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client", err);
  });

  return pool;
}

export async function checkDb(pool: Pool, timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([pool.query("SELECT 1"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
