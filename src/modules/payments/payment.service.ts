import type { Pool } from "pg";
import { withTransaction } from "../../db";

// Must match the payment_status enum in the database (a test checks this).
export const PAYMENT_STATUSES = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUPPORTED_CURRENCIES = ["USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const INITIAL_STATUS: PaymentStatus = "PENDING";

// The state machine: for each status, the statuses it may move to. Empty list = terminal.
const ALLOWED_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["PROCESSING", "CANCELED"],
  PROCESSING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface Payment {
  id: string;
  external_ref: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePaymentInput {
  amount_cents: number;
  currency: Currency;
}

export interface TransitionResult {
  payment: Payment;
  // false when the payment was already in the requested status (a safe repeat, nothing written).
  changed: boolean;
}

export class PaymentNotFoundError extends Error {
  constructor(public readonly paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = "PaymentNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly from: PaymentStatus,
    public readonly to: PaymentStatus,
  ) {
    super(`Payment ${paymentId} cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// node-postgres returns BIGINT as a string, because a JS number cannot hold every 64-bit integer.
type PaymentRow = Omit<Payment, "amount_cents"> & { amount_cents: string };

const COLUMNS = "id, external_ref, amount_cents, currency, status, created_at, updated_at";

function toPayment(row: PaymentRow): Payment {
  // Safe: createPayment only accepts amounts within Number.MAX_SAFE_INTEGER.
  return { ...row, amount_cents: Number(row.amount_cents) };
}

export interface PaymentService {
  createPayment(input: CreatePaymentInput): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  transitionPayment(id: string, to: PaymentStatus): Promise<TransitionResult>;
}

export function createPaymentService(pool: Pool): PaymentService {
  return {
    async createPayment(input) {
      const { rows } = await pool.query<PaymentRow>(
        `INSERT INTO payments (amount_cents, currency, status) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [input.amount_cents, input.currency, INITIAL_STATUS],
      );
      return toPayment(rows[0]!);
    },

    async getPayment(id) {
      const { rows } = await pool.query<PaymentRow>(`SELECT ${COLUMNS} FROM payments WHERE id = $1`, [id]);
      return rows[0] ? toPayment(rows[0]) : null;
    },

    // The only place in the codebase allowed to change payments.status.
    async transitionPayment(id, to) {
      return withTransaction(pool, async (client) => {
        // FOR UPDATE locks the row until COMMIT, so a concurrent transition waits here
        // and then sees the status we wrote, instead of deciding from a stale read.
        const current = await client.query<PaymentRow>(
          `SELECT ${COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const row = current.rows[0];
        if (!row) throw new PaymentNotFoundError(id);

        if (row.status === to) return { payment: toPayment(row), changed: false };
        if (!canTransition(row.status, to)) throw new InvalidTransitionError(id, row.status, to);

        const updated = await client.query<PaymentRow>(
          `UPDATE payments SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, to],
        );
        return { payment: toPayment(updated.rows[0]!), changed: true };
      });
    },
  };
}
