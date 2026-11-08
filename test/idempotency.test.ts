import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  idempotencyMiddleware,
  canonicalStringify,
  computeRequestHash,
  IdempotencyStore,
} from "../src/modules/common/middleware/idempotency";
import { errorHandler } from "../src/modules/common/middleware/errorHandler";
import { correlationIdMiddleware } from "../src/modules/common/middleware/correlationId";

describe("Idempotency Engine & Middleware (M5)", () => {
  describe("Canonical Hash & Deterministic Ordering", () => {
    it("should produce identical canonical string regardless of object key order", () => {
      const obj1 = { amount: 1000, currency: "USD", metadata: { b: 2, a: 1 } };
      const obj2 = { metadata: { a: 1, b: 2 }, currency: "USD", amount: 1000 };

      expect(canonicalStringify(obj1)).toBe(canonicalStringify(obj2));
      expect(computeRequestHash("POST", "/v1/payments", obj1)).toBe(
        computeRequestHash("POST", "/v1/payments", obj2)
      );
    });

    it("should produce different hash for different payload", () => {
      const hash1 = computeRequestHash("POST", "/v1/payments", { amount: 1000 });
      const hash2 = computeRequestHash("POST", "/v1/payments", { amount: 2000 });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Middleware Request Flow & Conflicts", () => {
    let mockStore: IdempotencyStore;
    let storeState: Map<string, any>;
    let executionCount: number;

    beforeEach(() => {
      storeState = new Map();
      executionCount = 0;

      mockStore = {
        claimKey: vi.fn(async (mId: string, key: string, hash: string) => {
          const compositeKey = `${mId}:${key}`;
          const existing = storeState.get(compositeKey);

          if (!existing) {
            storeState.set(compositeKey, { hash, status: "PROCESSING", code: null, body: null });
            return { state: "CLAIMED" };
          }

          if (existing.hash !== hash) {
            return { state: "PAYLOAD_MISMATCH" };
          }

          if (existing.status === "COMPLETED") {
            return { state: "REPLAY", statusCode: existing.code, body: existing.body };
          }

          return { state: "CONFLICT_IN_PROGRESS" };
        }),

        saveResponse: vi.fn(async (mId: string, key: string, code: number, body: unknown) => {
          const compositeKey = `${mId}:${key}`;
          const rec = storeState.get(compositeKey);
          if (rec) {
            rec.status = "COMPLETED";
            rec.code = code;
            rec.body = body;
          }
        }),
      };
    });

    function createAppWithIdempotency() {
      const app = express();
      app.use(express.json());
      app.use(correlationIdMiddleware);

      // Mock auth injecting merchant
      app.use((req, res, next) => {
        req.merchant = {
          id: "merchant-1",
          name: "Acme Corp",
          email: "acme@test.com",
          status: "ACTIVE",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        next();
      });

      app.post("/test-action", idempotencyMiddleware(mockStore), (req, res) => {
        executionCount += 1;
        res.status(201).json({ success: true, count: executionCount, echo: req.body });
      });

      app.use(errorHandler);
      return app;
    }

    it("should reject mutating request when Idempotency-Key header is missing with 400", async () => {
      const app = createAppWithIdempotency();
      const res = await request(app).post("/test-action").send({ amount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_REQUEST");
      expect(res.body.error.message).toContain("Missing required 'Idempotency-Key'");
      expect(executionCount).toBe(0);
    });

    it("should process request on first attempt and return response", async () => {
      const app = createAppWithIdempotency();
      const res = await request(app)
        .post("/test-action")
        .set("Idempotency-Key", "key-first-try-123")
        .send({ amount: 1000 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(executionCount).toBe(1);
    });

    it("should replay cached response on identical duplicate request with header", async () => {
      const app = createAppWithIdempotency();
      const key = "key-replay-test-456";

      // 1. First call
      const firstRes = await request(app)
        .post("/test-action")
        .set("Idempotency-Key", key)
        .send({ amount: 2000 });

      expect(firstRes.status).toBe(201);
      expect(executionCount).toBe(1);

      // 2. Duplicate call
      const replayRes = await request(app)
        .post("/test-action")
        .set("Idempotency-Key", key)
        .send({ amount: 2000 });

      expect(replayRes.status).toBe(201);
      expect(replayRes.headers["x-idempotent-replay"]).toBe("true");
      expect(replayRes.body.count).toBe(1); // handler was NOT called again!
      expect(executionCount).toBe(1);
    });

    it("should reject same key with DIFFERENT request body with 422 Unprocessable Entity", async () => {
      const app = createAppWithIdempotency();
      const key = "key-mismatch-test-789";

      // First call with amount: 1000
      await request(app)
        .post("/test-action")
        .set("Idempotency-Key", key)
        .send({ amount: 1000 });

      // Second call with DIFFERENT amount: 9999
      const mismatchRes = await request(app)
        .post("/test-action")
        .set("Idempotency-Key", key)
        .send({ amount: 9999 });

      expect(mismatchRes.status).toBe(422);
      expect(mismatchRes.body.error.code).toBe("UNPROCESSABLE_ENTITY");
      expect(mismatchRes.body.error.message).toContain("different request payload");
      expect(executionCount).toBe(1);
    });

    it("should return 409 Conflict when concurrent request is currently in progress", async () => {
      const app = createAppWithIdempotency();
      const key = "key-concurrent-test";

      // Simulate in-progress state
      storeState.set(`merchant-1:${key}`, {
        hash: computeRequestHash("POST", "/test-action", { amount: 500 }),
        status: "PROCESSING",
      });

      const res = await request(app)
        .post("/test-action")
        .set("Idempotency-Key", key)
        .send({ amount: 500 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
      expect(res.body.error.message).toContain("concurrent request is currently in progress");
      expect(executionCount).toBe(0);
    });
  });
});
