import { Pool, type PoolClient } from "pg";

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

// Runs fn on one dedicated connection inside BEGIN/COMMIT; any throw rolls everything back.
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // If the rollback itself fails (dead connection), still surface the original error.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
