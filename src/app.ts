import express, { type ErrorRequestHandler } from "express";
import { healthRouter } from "./modules/health/health.routes";

export interface AppDeps {
  checkDb: () => Promise<void>;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.use(healthRouter(deps.checkDb));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // body-parser errors (e.g. malformed JSON) carry a 4xx status; anything else is a 500.
    const status = typeof err?.status === "number" && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(onError);

  return app;
}
