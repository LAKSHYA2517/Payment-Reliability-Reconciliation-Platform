import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPaymentService } from "../src/modules/payments/payment.service";
import { createTestPool } from "./helpers/test-db";

const pool = createTestPool();
const app = createApp({ checkDb: async () => {}, payments: createPaymentService(pool) });

afterAll(() => pool.end());

describe("POST /payments", () => {
  it("creates a PENDING payment and returns 201", async () => {
    const res = await request(app).post("/payments").send({ amount_cents: 4999, currency: "USD" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      external_ref: null,
      amount_cents: 4999,
      currency: "USD",
      status: "PENDING",
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("stores each request as a separate payment (no idempotency yet)", async () => {
    const body = { amount_cents: 100, currency: "USD" };
    const first = await request(app).post("/payments").send(body);
    const second = await request(app).post("/payments").send(body);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it.each([
    ["missing amount_cents", { currency: "USD" }, "amount_cents"],
    ["zero amount", { amount_cents: 0, currency: "USD" }, "amount_cents"],
    ["negative amount", { amount_cents: -5, currency: "USD" }, "amount_cents"],
    ["fractional amount", { amount_cents: 10.5, currency: "USD" }, "amount_cents"],
    ["amount as a string", { amount_cents: "100", currency: "USD" }, "amount_cents"],
    ["amount beyond the safe integer range", { amount_cents: 2 ** 60, currency: "USD" }, "amount_cents"],
    ["missing currency", { amount_cents: 100 }, "currency"],
    ["unsupported currency", { amount_cents: 100, currency: "EUR" }, "currency"],
    ["lowercase currency", { amount_cents: 100, currency: "usd" }, "currency"],
    ["client-supplied status", { amount_cents: 100, currency: "USD", status: "SUCCEEDED" }, ""],
  ])("rejects %s with 400", async (_name, body, path) => {
    const res = await request(app).post("/payments").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it("rejects a request with no body", async () => {
    const res = await request(app).post("/payments");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });
});

describe("GET /payments/:id", () => {
  it("returns a payment that was created", async () => {
    const created = await request(app).post("/payments").send({ amount_cents: 750, currency: "USD" });

    const res = await request(app).get(`/payments/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  it("returns 404 for a payment that does not exist", async () => {
    const res = await request(app).get("/payments/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "payment_not_found" });
  });

  it("returns 400 for an id that is not a UUID", async () => {
    const res = await request(app).get("/payments/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "validation_error", details: [{ path: "id", message: expect.any(String) }] });
  });
});
