import { Router } from "express";

export function healthRouter(checkDb: () => Promise<void>): Router {
  const router = Router();

  router.get("/healthz", async (_req, res) => {
    // Reaching this handler already proves the process is alive and serving HTTP.
    try {
      await checkDb();
      res.status(200).json({ status: "ok", checks: { app: "up", database: "up" } });
    } catch (err) {
      console.error("Health check: database unreachable", err);
      res.status(503).json({ status: "unavailable", checks: { app: "up", database: "down" } });
    }
  });

  return router;
}
