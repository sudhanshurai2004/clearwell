import express, { type Express, type Request, type Response } from "express";
import { newId } from "../modules/common/ids";
import type { Logger } from "../modules/common/logger";
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./psp-signature";
import { PspStore, type FaultMode, type PspPayment } from "./psp-state";

export type PspSimulatorDeps = {
  readonly logger: Logger;
  readonly callbackSecret: string;
  /** Where we POST async callbacks (the API's /v1/internal/psp/callbacks). */
  readonly callbackUrl: string;
  readonly store?: PspStore;
};

/**
 * THE SIMULATED PSP.
 *
 * A real provider is a black box reached over the network that can fail in
 * interesting ways. Reproducing those failures is impossible against a real
 * sandbox, so we build the black box: latency, declines, timeouts, duplicate
 * callbacks, out-of-order callbacks, settlement files.
 *
 * Fault injection is per request (`fault` field) so tests can be exact, and
 * globally via POST /psp/_faults so a demo can show "the provider is slow now".
 */
export function createPspSimulator(deps: PspSimulatorDeps): Express {
  const store = deps.store ?? new PspStore();
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.set("pspStore", store);
  app.set("pspSecret", deps.callbackSecret);

  // Global fault configuration, changed at runtime by tests and demos.
  const faults = {
    latencyMs: 0,
    declineNext: 0,
    timeoutNext: 0,
    duplicateCallbacks: false,
    outOfOrderCallbacks: false,
  };

  /** Simulated network latency: the main reason the caller must not hold a DB lock. */
  const delay = async (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);

  const paymentJson = (p: PspPayment) => ({
    id: p.id,
    our_reference: p.ourReference,
    amount_minor: p.amount.toString(),
    currency: p.currency,
    status: p.status,
    captured_amount_minor: p.capturedAmount.toString(),
    refunded_amount_minor: p.refundedAmount.toString(),
    ...(p.declineCode ? { decline_code: p.declineCode } : {}),
  });

  /**
   * Idempotency, provider side: same reference + same operation returns the
   * stored result. A retry after a timeout therefore cannot charge twice.
   */
  const idempotent = (
    payment: PspPayment,
    operation: string,
    compute: () => { status: number; body: Record<string, unknown> },
  ) => {
    const cached = payment.idempotency.get(operation);
    if (cached) {
      deps.logger.info({ psp_ref: payment.id, operation }, "psp_idempotent_replay");
      return { ...cached, replayed: true };
    }
    const result = compute();
    payment.idempotency.set(operation, result);
    return { ...result, replayed: false };
  };

  // --------------------------------------------------------------- health
  app.get("/psp/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", payments: store.all().length });
  });

  // ---------------------------------------------------------- authorize
  /**
   * POST /psp/authorize
   * body: { our_reference, amount_minor, currency, fault? }
   *
   * `fault: "timeout"` is the interesting one: the provider DOES authorise but
   * the response never arrives. We emulate that by recording the payment and
   * then holding the connection open until the caller gives up (AbortSignal) or
   * a long delay passes. Our API must end up in UNKNOWN, never DECLINED.
   */
  app.post("/psp/authorize", async (req: Request, res: Response) => {
    const { our_reference, amount_minor, currency } = req.body ?? {};
    const fault = (req.body?.fault as FaultMode | undefined) ?? undefined;

    if (typeof our_reference !== "string" || typeof amount_minor !== "string") {
      res.status(400).json({ error: { code: "PSP_BAD_REQUEST", message: "our_reference and amount_minor are required" } });
      return;
    }
    if (faults.latencyMs > 0) await delay(faults.latencyMs);

    let effectiveFault = fault;
    if (!effectiveFault && faults.declineNext > 0) {
      faults.declineNext -= 1;
      effectiveFault = "decline";
    }
    if (!effectiveFault && faults.timeoutNext > 0) {
      faults.timeoutNext -= 1;
      effectiveFault = "timeout";
    }

    const existing = store.findByReference(our_reference);
    const payment =
      existing ??
      store.createPayment({
        ourReference: our_reference,
        amount: BigInt(amount_minor),
        currency: String(currency ?? "USD"),
        ...(effectiveFault ? { fault: effectiveFault } : {}),
      });

    if (effectiveFault === "timeout") {
      // Authorised on the provider side, but the client will never learn it.
      deps.logger.warn({ our_reference }, "psp_authorize_timeout");
      await delay(30_000);
      if (!res.headersSent) res.status(504).json({ error: { code: "PSP_TIMEOUT" } });
      return;
    }

    const result = idempotent(payment, "AUTHORIZE", () =>
      payment.status === "DECLINED"
        ? {
            status: 402,
            body: { error: { code: "card_declined", message: "The card was declined" }, psp_ref: payment.id },
          }
        : { status: 200, body: paymentJson(payment) },
    );

    res.status(result.status).json(result.body);
  });

  // ------------------------------------------------------------- capture
  app.post("/psp/capture", async (req: Request, res: Response) => {
    const { our_reference, amount_minor } = req.body ?? {};
    if (faults.latencyMs > 0) await delay(faults.latencyMs);

    const payment = store.findByReference(String(our_reference));
    if (!payment) {
      res.status(404).json({ error: { code: "not_found", message: "Unknown our_reference" } });
      return;
    }

    const requested = BigInt(amount_minor ?? "0");
    const result = idempotent(payment, `CAPTURE:${requested}`, () => {
      if (payment.status === "DECLINED") {
        return { status: 402, body: { error: { code: "card_declined" }, psp_ref: payment.id } };
      }
      if (payment.status === "AUTHORIZED" || payment.status === "PARTIALLY_REFUNDED") {
        payment.status = "CAPTURED";
        payment.capturedAmount += requested;
        return { status: 200, body: paymentJson(payment) };
      }
      return {
        status: 409,
        body: { error: { code: "invalid_state", message: `cannot capture from ${payment.status}` }, psp_ref: payment.id },
      };
    });

    res.status(result.status).json(result.body);
  });

  // ---------------------------------------------------------------- void
  app.post("/psp/void", async (req: Request, res: Response) => {
    const { our_reference } = req.body ?? {};
    if (faults.latencyMs > 0) await delay(faults.latencyMs);
    const payment = store.findByReference(String(our_reference));
    if (!payment) {
      res.status(404).json({ error: { code: "not_found" } });
      return;
    }
    const result = idempotent(payment, "VOID", () => {
      if (payment.status === "AUTHORIZED") {
        payment.status = "VOIDED";
        return { status: 200, body: paymentJson(payment) };
      }
      return {
        status: 409,
        body: { error: { code: "invalid_state", message: `cannot void from ${payment.status}` } },
      };
    });
    res.status(result.status).json(result.body);
  });

  // -------------------------------------------------------------- refund
  app.post("/psp/refund", async (req: Request, res: Response) => {
    const { our_reference, amount_minor } = req.body ?? {};
    if (faults.latencyMs > 0) await delay(faults.latencyMs);
    const payment = store.findByReference(String(our_reference));
    if (!payment) {
      res.status(404).json({ error: { code: "not_found" } });
      return;
    }
    const requested = BigInt(amount_minor ?? "0");
    const result = idempotent(payment, `REFUND:${requested}:${payment.refundedAmount}`, () => {
      const refundable = payment.capturedAmount - payment.refundedAmount;
      if (requested <= 0n || requested > refundable) {
        return {
          status: 409,
          body: { error: { code: "refund_exceeds_captured", message: `refundable=${refundable}` } },
        };
      }
      payment.refundedAmount += requested;
      payment.status = payment.refundedAmount === payment.capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";
      return { status: 200, body: paymentJson(payment) };
    });
    res.status(result.status).json(result.body);
  });

  // ------------------------------------------------------- status inquiry
  /**
   * The recovery sweeper's lifeline: after an UNKNOWN authorize we ask the
   * provider what actually happened, using OUR reference (the only identifier
   * we are guaranteed to have, since we may never have seen the response).
   */
  app.get("/psp/payments/:ourReference", async (req: Request, res: Response) => {
    if (faults.latencyMs > 0) await delay(faults.latencyMs);
    const payment = store.findByReference(req.params["ourReference"] as string);
    if (!payment) {
      res.status(404).json({ error: { code: "not_found", message: "No such payment at the provider" } });
      return;
    }
    res.json(paymentJson(payment));
  });

  // ---------------------------------------------------------- settlement
  /**
   * Nightly settlement file, CSV exactly as specified:
   * psp_ref, our_payment_id, amount, currency, status, settled_at
   * `our_payment_id` is the reference WE sent -- that is how reconciliation
   * matches provider rows to our ledger.
   */
  app.get("/psp/settlement", (req: Request, res: Response) => {
    const date = String(req.query["date"] ?? new Date().toISOString().slice(0, 10));
    const rows = ["psp_ref,our_payment_id,amount,currency,status,settled_at"];
    for (const payment of store.all()) {
      if (payment.status === "DECLINED" || payment.status === "VOIDED") continue;
      const settled = payment.capturedAmount > 0n ? payment.capturedAmount : payment.amount;
      rows.push(
        [
          payment.id,
          payment.ourReference,
          settled.toString(),
          payment.currency,
          payment.status,
          `${date}T00:00:00Z`,
        ].join(","),
      );
    }
    res.type("text/csv").send(`${rows.join("\n")}\n`);
  });

  // ------------------------------------------------------ fault control
  /** One wire format everywhere: snake_case, like the rest of the PSP API. */
  const faultsJson = () => ({
    latency_ms: faults.latencyMs,
    decline_next: faults.declineNext,
    timeout_next: faults.timeoutNext,
    duplicate_callbacks: faults.duplicateCallbacks,
    out_of_order_callbacks: faults.outOfOrderCallbacks,
  });

  app.post("/psp/_faults", (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (typeof body.latency_ms === "number") faults.latencyMs = body.latency_ms;
    if (typeof body.decline_next === "number") faults.declineNext = body.decline_next;
    if (typeof body.timeout_next === "number") faults.timeoutNext = body.timeout_next;
    if (typeof body.duplicate_callbacks === "boolean") faults.duplicateCallbacks = body.duplicate_callbacks;
    if (typeof body.out_of_order_callbacks === "boolean") faults.outOfOrderCallbacks = body.out_of_order_callbacks;
    res.json({ faults: faultsJson() });
  });

  app.get("/psp/_faults", (_req: Request, res: Response) => {
    res.json({ faults: faultsJson() });
  });

  /**
   * Delivers (and optionally duplicates / reorders) the async callbacks a real
   * provider would send. Exposed separately from the business endpoints so a
   * test can control exactly when the callback races the synchronous response.
   */
  app.post("/psp/_flush-callbacks", async (_req: Request, res: Response) => {
    const pending = store.pendingCallbacks();
    const deliveries = faults.duplicateCallbacks ? [...pending, ...pending] : pending;
    const ordered = faults.outOfOrderCallbacks ? [...deliveries].reverse() : deliveries;

    const results: { status: number }[] = [];
    for (const item of ordered) {
      const body = JSON.stringify({ ...item.payload, event_id: newId() });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signPayload(deps.callbackSecret, timestamp, body);
      try {
        const response = await fetch(item.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signature,
            [TIMESTAMP_HEADER]: timestamp,
          },
          body,
        });
        results.push({ status: response.status });
      } catch (err) {
        deps.logger.warn({ err }, "psp_callback_delivery_failed");
        results.push({ status: 0 });
      }
    }
    store.clearCallbacks();
    res.json({ delivered: results.length, results });
  });

  app.post("/psp/_reset", (_req: Request, res: Response) => {
    store.reset();
    faults.latencyMs = 0;
    faults.declineNext = 0;
    faults.timeoutNext = 0;
    faults.duplicateCallbacks = false;
    faults.outOfOrderCallbacks = false;
    res.json({ status: "reset" });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "not_found" } });
  });

  return app;
}

export function createStandalonePsp(deps: PspSimulatorDeps & { port: number }) {
  const app = createPspSimulator(deps);
  return app.listen(deps.port, "0.0.0.0", () => {
    deps.logger.info({ port: deps.port }, "psp_simulator_started");
  });
}
