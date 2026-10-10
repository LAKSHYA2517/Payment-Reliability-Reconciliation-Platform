import { afterAll, describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  PAYMENT_STATUSES,
  PaymentNotFoundError,
  createPaymentService,
  type PaymentStatus,
} from "../src/modules/payments/payment.service";
import { createTestPool } from "./helpers/test-db";

const pool = createTestPool();
const payments = createPaymentService(pool);

afterAll(() => pool.end());

// Creates a fresh payment and walks it along a valid path to the wanted starting status.
async function paymentIn(status: PaymentStatus): Promise<string> {
  const paths: Record<PaymentStatus, PaymentStatus[]> = {
    PENDING: [],
    PROCESSING: ["PROCESSING"],
    SUCCEEDED: ["PROCESSING", "SUCCEEDED"],
    FAILED: ["PROCESSING", "FAILED"],
    CANCELED: ["CANCELED"],
  };
  const { id } = await payments.createPayment({ amount_cents: 1000, currency: "USD" });
  for (const step of paths[status]) await payments.transitionPayment(id, step);
  return id;
}

describe("createPayment / getPayment", () => {
  it("creates a PENDING payment and reads it back", async () => {
    const created = await payments.createPayment({ amount_cents: 2599, currency: "USD" });

    expect(created).toMatchObject({ amount_cents: 2599, currency: "USD", status: "PENDING", external_ref: null });
    expect(created.created_at).toBeInstanceOf(Date);
    expect(await payments.getPayment(created.id)).toEqual(created);
  });

  it("returns null for a payment that does not exist", async () => {
    expect(await payments.getPayment("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("keeps large amounts exact", async () => {
    const created = await payments.createPayment({ amount_cents: Number.MAX_SAFE_INTEGER, currency: "USD" });
    expect(created.amount_cents).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("transitionPayment", () => {
  it.each<[PaymentStatus, PaymentStatus]>([
    ["PENDING", "PROCESSING"],
    ["PENDING", "CANCELED"],
    ["PROCESSING", "SUCCEEDED"],
    ["PROCESSING", "FAILED"],
  ])("allows %s -> %s and persists it", async (from, to) => {
    const id = await paymentIn(from);

    const result = await payments.transitionPayment(id, to);

    expect(result.changed).toBe(true);
    expect(result.payment.status).toBe(to);
    expect((await payments.getPayment(id))?.status).toBe(to);
  });

  it.each<[PaymentStatus, PaymentStatus]>([
    ["PENDING", "SUCCEEDED"],
    ["PENDING", "FAILED"],
    ["PROCESSING", "CANCELED"],
    ["PROCESSING", "PENDING"],
    ["SUCCEEDED", "FAILED"],
    ["SUCCEEDED", "PROCESSING"],
    ["FAILED", "SUCCEEDED"],
    ["CANCELED", "PROCESSING"],
  ])("rejects %s -> %s and leaves the payment untouched", async (from, to) => {
    const id = await paymentIn(from);
    const before = await payments.getPayment(id);

    const error = await payments.transitionPayment(id, to).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error).toMatchObject({ paymentId: id, from, to });
    expect(await payments.getPayment(id)).toEqual(before);
  });

  it("treats a repeated transition as a no-op instead of an error", async () => {
    const id = await paymentIn("PENDING");
    const first = await payments.transitionPayment(id, "PROCESSING");

    const second = await payments.transitionPayment(id, "PROCESSING");

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.payment).toEqual(first.payment);
  });

  it("allows repeating a transition into a terminal status", async () => {
    const id = await paymentIn("SUCCEEDED");
    const result = await payments.transitionPayment(id, "SUCCEEDED");
    expect(result.changed).toBe(false);
  });

  it("throws PaymentNotFoundError for an unknown payment", async () => {
    await expect(payments.transitionPayment("00000000-0000-4000-8000-000000000000", "PROCESSING")).rejects.toBeInstanceOf(
      PaymentNotFoundError,
    );
  });
});

describe("transitionPayment under concurrency", () => {
  it("lets exactly one of two conflicting transitions win", async () => {
    for (let round = 0; round < 20; round++) {
      const id = await paymentIn("PENDING");

      const results = await Promise.allSettled([
        payments.transitionPayment(id, "PROCESSING"),
        payments.transitionPayment(id, "CANCELED"),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toBeInstanceOf(InvalidTransitionError);
      expect((await payments.getPayment(id))?.status).toBe(won[0]?.value.payment.status);
    }
  });

  it("applies the change once when the same transition is requested many times at once", async () => {
    const id = await paymentIn("PENDING");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => payments.transitionPayment(id, "PROCESSING")),
    );

    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.payment.updated_at.getTime())).size).toBe(1);
  });
});

describe("schema", () => {
  it("has the same statuses in the database enum as in the code", async () => {
    const { rows } = await pool.query<{ status: string }>(
      "SELECT unnest(enum_range(NULL::payment_status))::text AS status",
    );
    expect(rows.map((r) => r.status)).toEqual([...PAYMENT_STATUSES]);
  });
});
