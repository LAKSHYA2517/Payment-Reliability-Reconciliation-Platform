import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

describe("GET /healthz", () => {
  it("returns 200 when the database check succeeds", async () => {
    const app = createApp({ checkDb: async () => {} });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { app: "up", database: "up" } });
  });

  it("returns 503 when the database check fails, while reporting the app as up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ checkDb: async () => { throw new Error("connection refused"); } });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", checks: { app: "up", database: "down" } });
  });
});

describe("app fallbacks", () => {
  const app = createApp({ checkDb: async () => {} });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 400 for malformed JSON bodies instead of a 500", async () => {
    const res = await request(app).post("/anything").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
  });
});
