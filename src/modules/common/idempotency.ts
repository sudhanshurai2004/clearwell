import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { AppError } from "./errors";

/**
 * IDEMPOTENCY
 *
 * Wraps a mutating route handler so that retrying a request cannot repeat its
 * side effects. The contract with the client:
 *
 *   Idempotency-Key: <client-generated, unique per retry group>
 *
 *   first request             -> handler runs, response is stored
 *   same key + same body      -> stored response replayed, handler NOT run
 *   same key + different body -> 422 (the key was reused for another request)
 *   same key, still running   -> waits briefly, then 409
 *   same key, stale lock      -> one waiter takes the lease over (conditional
 *                                UPDATE), and the handler itself re-checks the
 *                                resource state before doing any work
 *
 * Design notes:
 *  - The key is scoped per merchant and the fingerprint includes method + path +
 *    body hash, so a key cannot be borrowed across endpoints or bodies.
 *  - The claim is a single INSERT ... ON CONFLICT DO NOTHING: Postgres decides
 *    the winner atomically, no read-then-write race.
 *  - Nothing is held open during the handler. The claim commits immediately and
 *    the handler talks to the provider on its own connections, exactly like the
 *    payment flow does.
 *  - The response is captured in a res.json interceptor, so the stored payload
 *    is byte-identical to what the first caller saw.
 */

const KEY_REGEX = /^[A-Za-z0-9._:-]{8,255}$/;
const LEASE_SECONDS = 30;
const WAIT_TOTAL_MS = 2_000;
const WAIT_STEP_MS = 100;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The REAL request hash for an incoming request. Used by the middleware and
 * exposed so tests (and tooling) can pre-seed a key exactly the way production
 * would. Path = the full request path without the query string, so the same key
 * on a different endpoint can never collide.
 */
export function requestFingerprint(req: { method: string; originalUrl: string; body: unknown }): string {
  return fingerprint(req.method, req.originalUrl.split("?")[0] ?? req.originalUrl, req.body);
}

export function fingerprint(method: string, path: string, body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${method.toUpperCase()}|${path}|${canonicalJson(body ?? {})}`, "utf8")
    .digest("hex");
}

type ClaimResult =
  | { kind: "claimed" }
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "conflict_body" }
  | { kind: "in_progress" };

type ClaimInput = {
  merchantId: string;
  key: string;
  requestHash: string;
  method: string;
  path: string;
};

async function claim(pool: Pool, input: ClaimInput): Promise<ClaimResult> {
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys
       (merchant_id, key, request_hash, method, path, status, locked_until)
     VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + ($6 || ' seconds')::interval)
     ON CONFLICT (merchant_id, key) DO NOTHING
     RETURNING key`,
    [input.merchantId, input.key, input.requestHash, input.method, input.path, String(LEASE_SECONDS)],
  );
  if (inserted.rowCount === 1) return { kind: "claimed" };

  const existing = await pool.query<{
    request_hash: string;
    status: string;
    response_code: number | null;
    response_body: unknown;
    locked_until: Date | null;
  }>(
    `SELECT request_hash, status, response_code, response_body, locked_until
       FROM idempotency_keys
      WHERE merchant_id = $1 AND key = $2`,
    [input.merchantId, input.key],
  );
  const row = existing.rows[0];
  if (!row) return { kind: "claimed" }; // vanished between statements: treat as fresh

  // ORDER MATTERS. Only a SUCCESSFUL response is a permanent answer to a key.
  // A failed request (400 validation, 409 race, 502/504 provider) must be
  // retryable -- and a retry legitimately carries a *corrected* body, so the
  // hash comparison only applies to successful records. Checking the hash first
  // would let one validation error poison the key forever (a real bug the tests
  // caught), and would turn "fix your request and retry" into a 422.
  const isSuccess =
    row.status === "COMPLETED" && (row.response_code ?? 0) >= 200 && (row.response_code ?? 0) < 300;

  if (isSuccess) {
    if (row.request_hash !== input.requestHash) return { kind: "conflict_body" };
    return { kind: "replay", statusCode: row.response_code ?? 200, body: row.response_body };
  }

  if (row.status === "COMPLETED" || row.status === "FAILED") {
    // Retryable failure: take the key over and run the request again.
    const released = await pool.query(
      `UPDATE idempotency_keys
          SET status = 'IN_PROGRESS',
              request_hash = $4,
              locked_until = now() + ($3 || ' seconds')::interval,
              attempts = attempts + 1,
              updated_at = now()
        WHERE merchant_id = $1 AND key = $2
          AND status IN ('FAILED','COMPLETED')
          AND (response_code IS NULL OR response_code < 200 OR response_code >= 300)
        RETURNING key`,
      [input.merchantId, input.key, String(LEASE_SECONDS), input.requestHash],
    );
    return released.rowCount === 1 ? { kind: "claimed" } : { kind: "in_progress" };
  }

  // Still IN_PROGRESS: the body must match, otherwise this is a different
  // request reusing a key that is currently being executed.
  if (row.request_hash !== input.requestHash) return { kind: "conflict_body" };

  if (row.locked_until && row.locked_until.getTime() > Date.now()) return { kind: "in_progress" };

  // STALE LEASE: someone died mid-request. Take it over with a conditional
  // UPDATE so exactly one waiter wins; the handler then re-reads the payment.
  const takeover = await pool.query(
    `UPDATE idempotency_keys
        SET locked_until = now() + ($3 || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = now()
      WHERE merchant_id = $1 AND key = $2
        AND status = 'IN_PROGRESS'
        AND (locked_until IS NULL OR locked_until <= now())
      RETURNING key`,
    [input.merchantId, input.key, String(LEASE_SECONDS)],
  );
  return takeover.rowCount === 1 ? { kind: "claimed" } : { kind: "in_progress" };
}

async function persist(
  pool: Pool,
  input: {
    merchantId: string;
    key: string;
    statusCode: number;
    body: unknown;
    paymentId?: string | null;
    failed?: boolean;
  },
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
        SET status = $3,
            response_code = $4,
            response_body = $5,
            payment_id = COALESCE($6, payment_id),
            locked_until = NULL,
            updated_at = now()
      WHERE merchant_id = $1 AND key = $2`,
    [
      input.merchantId,
      input.key,
      input.failed ? "FAILED" : "COMPLETED",
      input.statusCode,
      JSON.stringify(input.body ?? null),
      input.paymentId ?? null,
    ],
  );
}

/**
 * Wraps a handler. Use on every mutating route:
 *   router.post("/payments", auth, idempotent(controller.create()))
 */
export function idempotent(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const auth = req.auth;
      if (!auth) throw AppError.unauthenticated();

      const rawKey = req.header("idempotency-key");
      if (!rawKey) {
        throw AppError.validation(
          [{ field: "Idempotency-Key", message: "header is required for mutating requests" }],
          "Idempotency-Key header is required",
        );
      }
      if (!KEY_REGEX.test(rawKey)) {
        throw AppError.validation(
          [{ field: "Idempotency-Key", message: "must be 8-255 chars of [A-Za-z0-9._:-]" }],
          "Malformed Idempotency-Key",
        );
      }

      const pool = req.app.get("pool") as Pool;
      const path = req.originalUrl.split("?")[0] ?? req.path;
      const requestHash = requestFingerprint(req);
      const claimInput: ClaimInput = {
        merchantId: auth.merchantId,
        key: rawKey,
        requestHash,
        method: req.method,
        path,
      };

      const deadline = Date.now() + WAIT_TOTAL_MS;
      let result = await claim(pool, claimInput);
      while (result.kind === "in_progress" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
        result = await claim(pool, claimInput);
      }

      if (result.kind === "conflict_body") {
        throw AppError.unprocessable(
          "This Idempotency-Key was already used with a different request body",
        );
      }
      if (result.kind === "in_progress") {
        throw new AppError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "An identical request is still being processed. Retry shortly or poll the resource.",
        );
      }
      if (result.kind === "replay") {
        res.setHeader("Idempotent-Replay", "true");
        res.status(result.statusCode).json(result.body);
        return;
      }

      // We own the key. The handler is invoked normally and writes through the
      // res.json interceptor, which:
      //   1. records the outcome (success -> replayable, error -> retryable)
      //   2. only then sends the response to the client
      //
      // NOTE: we deliberately do NOT await the handler's return value. Our own
      // asyncHandler wraps handlers and returns void (its promise is consumed to
      // forward rejections), so waiting on it would never resolve. The response
      // lifecycle is the reliable signal.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const statusCode = res.statusCode;
        const isSuccess = statusCode >= 200 && statusCode < 300;
        void persist(pool, {
          merchantId: auth.merchantId,
          key: rawKey,
          statusCode,
          body,
          paymentId: isSuccess ? extractId(body) : null,
          failed: !isSuccess,
        })
          .catch(() => undefined)
          .then(() => {
            originalJson(body);
          });
        return res;
      };

      // Hand over to the real route handler.
      handler(req, res, next);
    })().catch((err: unknown) => {
      // Claiming failed (DB down, bad key): let the error middleware answer.
      next(err);
    });
  };
}

function extractId(body: unknown): string | null {
  if (body && typeof body === "object" && "id" in body) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}
