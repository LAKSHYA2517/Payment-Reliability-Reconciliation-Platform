import { createApp } from "./app";
import { loadConfig } from "./config";
import { checkDb, createPool } from "./db";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = createApp({ checkDb: () => checkDb(pool) });

const server = app.listen(config.PORT, () => {
  console.log(`Server listening on port ${config.PORT} (${config.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
