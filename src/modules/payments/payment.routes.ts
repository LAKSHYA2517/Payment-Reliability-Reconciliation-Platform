import { Router, type Response } from "express";
import { z } from "zod";
import { SUPPORTED_CURRENCIES, type PaymentService } from "./payment.service";

// strictObject rejects unknown keys, so a client cannot smuggle in fields like "status".
const createPaymentSchema = z.strictObject({
  amount_cents: z.int().positive(),
  currency: z.enum(SUPPORTED_CURRENCIES),
});

const paymentParamsSchema = z.object({ id: z.uuid() });

function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "validation_error",
    details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function paymentRouter(payments: PaymentService): Router {
  const router = Router();

  router.post("/payments", async (req, res) => {
    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const payment = await payments.createPayment(parsed.data);
    res.status(201).json(payment);
  });

  router.get("/payments/:id", async (req, res) => {
    // Checked here because Postgres throws on a malformed UUID, which would surface as a 500.
    const params = paymentParamsSchema.safeParse(req.params);
    if (!params.success) return sendValidationError(res, params.error);

    const payment = await payments.getPayment(params.data.id);
    if (!payment) {
      res.status(404).json({ error: "payment_not_found" });
      return;
    }
    res.status(200).json(payment);
  });

  return router;
}
