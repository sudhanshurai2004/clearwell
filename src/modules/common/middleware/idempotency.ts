import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { pool } from "../db";
import { BadRequestError, ConflictError, UnprocessableEntityError } from "../errors";

/**
 * Deterministically serializes an object by sorting keys recursively.
 * Ensures identical request bodies produce identical SHA-256 hashes.
 */
export function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify((obj as Record<string, unknown>)[key])}`
  );
  return `{${entries.join(",")}}`;
}

export function computeRequestHash(method: string, path: string, body: unknown): string {
  const payload = `${method.toUpperCase()}:${path}:${canonicalStringify(body || {})}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface IdempotencyStore {
  claimKey(
    merchantId: string,
    key: string,
    requestHash: string,
    lockDurationSeconds?: number
  ): Promise<
    | { state: "CLAIMED" }
    | { state: "REPLAY"; statusCode: number; body: unknown }
    | { state: "CONFLICT_IN_PROGRESS" }
    | { state: "PAYLOAD_MISMATCH" }
  >;
  saveResponse(
    merchantId: string,
    key: string,
    statusCode: number,
    body: unknown
  ): Promise<void>;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly dbPool = pool) {}

  async claimKey(
    merchantId: string,
    key: string,
    requestHash: string,
    lockDurationSeconds = 120
  ): Promise<
    | { state: "CLAIMED" }
    | { state: "REPLAY"; statusCode: number; body: unknown }
    | { state: "CONFLICT_IN_PROGRESS" }
    | { state: "PAYLOAD_MISMATCH" }
  > {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");

      const selectSql = `
        SELECT key, request_hash, status, response_code, response_body, locked_until
        FROM idempotency_keys
        WHERE merchant_id = $1 AND key = $2
        FOR UPDATE
      `;
      const selectRes = await client.query(selectSql, [merchantId, key]);

      if (selectRes.rows.length === 0) {
        // First time seeing this key: claim it atomically
        const insertSql = `
          INSERT INTO idempotency_keys (merchant_id, key, request_hash, status, locked_until)
          VALUES ($1, $2, $3, 'PROCESSING', NOW() + ($4 || ' seconds')::interval)
        `;
        await client.query(insertSql, [merchantId, key, requestHash, lockDurationSeconds]);
        await client.query("COMMIT");
        return { state: "CLAIMED" };
      }

      const existing = selectRes.rows[0];

      // Check for payload mismatch (same key, different request body)
      if (existing.request_hash !== requestHash) {
        await client.query("ROLLBACK");
        return { state: "PAYLOAD_MISMATCH" };
      }

      // Check if already completed: replay cached response
      if (existing.status === "COMPLETED") {
        await client.query("COMMIT");
        return {
          state: "REPLAY",
          statusCode: existing.response_code,
          body: existing.response_body,
        };
      }

      // Check if in progress and still within lock timeout
      const isLockActive = new Date(existing.locked_until) > new Date();
      if (isLockActive) {
        await client.query("ROLLBACK");
        return { state: "CONFLICT_IN_PROGRESS" };
      }

      // Lock expired (stale lock from previous crash): re-claim
      const updateSql = `
        UPDATE idempotency_keys
        SET status = 'PROCESSING', locked_until = NOW() + ($1 || ' seconds')::interval, updated_at = NOW()
        WHERE merchant_id = $2 AND key = $3
      `;
      await client.query(updateSql, [lockDurationSeconds, merchantId, key]);
      await client.query("COMMIT");
      return { state: "CLAIMED" };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async saveResponse(
    merchantId: string,
    key: string,
    statusCode: number,
    body: unknown
  ): Promise<void> {
    const sql = `
      UPDATE idempotency_keys
      SET 
        status = 'COMPLETED',
        response_code = $1,
        response_body = $2,
        updated_at = NOW()
      WHERE merchant_id = $3 AND key = $4
    `;
    await this.dbPool.query(sql, [statusCode, JSON.stringify(body), merchantId, key]);
  }
}

export const defaultIdempotencyStore = new PostgresIdempotencyStore();

export function idempotencyMiddleware(store: IdempotencyStore = defaultIdempotencyStore) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    // Only apply to mutating HTTP methods
    const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];
    if (!mutatingMethods.includes(req.method)) {
      next();
      return;
    }

    const rawKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
    if (!rawKey || typeof rawKey !== "string" || rawKey.trim().length === 0) {
      next(new BadRequestError("Missing required 'Idempotency-Key' header on mutating request"));
      return;
    }

    const idempotencyKey = rawKey.trim();
    if (idempotencyKey.length < 4 || idempotencyKey.length > 255) {
      next(new BadRequestError("Idempotency-Key must be between 4 and 255 characters"));
      return;
    }

    // Ensure merchant context exists (requires authenticateApiKey before idempotency)
    const merchantId = req.merchant?.id;
    if (!merchantId) {
      next(new BadRequestError("Authentication required before idempotency validation"));
      return;
    }

    const requestHash = computeRequestHash(req.method, req.originalUrl || req.path, req.body);

    try {
      const claimResult = await store.claimKey(merchantId, idempotencyKey, requestHash);

      if (claimResult.state === "PAYLOAD_MISMATCH") {
        throw new UnprocessableEntityError(
          "Idempotency key was previously used with a different request payload or endpoint"
        );
      }

      if (claimResult.state === "CONFLICT_IN_PROGRESS") {
        throw new ConflictError(
          "A concurrent request is currently in progress with this idempotency key. Please retry after it completes."
        );
      }

      if (claimResult.state === "REPLAY") {
        res.setHeader("x-idempotent-replay", "true");
        res.status(claimResult.statusCode).json(claimResult.body);
        return;
      }

      // Claimed successfully: intercept response to store cached output on completion
      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        // Fire-and-forget background update to avoid delaying response delivery
        store.saveResponse(merchantId, idempotencyKey, res.statusCode, body).catch((err) => {
          console.error("Failed to save idempotent response:", err);
        });
        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
