import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, canTransition } from "../src/modules/payments/payment.service";

const VALID = new Set([
  "PENDING -> PROCESSING",
  "PENDING -> CANCELED",
  "PROCESSING -> SUCCEEDED",
  "PROCESSING -> FAILED",
]);

// Every one of the 25 from/to pairs, so adding a status forces a decision about each new pair.
const allPairs = PAYMENT_STATUSES.flatMap((from) => PAYMENT_STATUSES.map((to) => ({ from, to })));

describe("canTransition", () => {
  it.each(allPairs)("$from -> $to", ({ from, to }) => {
    expect(canTransition(from, to)).toBe(VALID.has(`${from} -> ${to}`));
  });
});
