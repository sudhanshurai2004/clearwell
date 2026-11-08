import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthMiddleware, requireScope } from "../src/modules/merchant/middleware/authenticateApiKey";
import { generateApiKey } from "../src/modules/merchant/merchant.crypto";
import { errorHandler } from "../src/modules/common/middleware/errorHandler";
import { correlationIdMiddleware } from "../src/modules/common/middleware/correlationId";
import { MerchantService } from "../src/modules/merchant/merchant.service";
import { NotFoundError } from "../src/modules/common/errors";

describe("Merchant Authentication & Tenant Isolation", () => {
  const { rawKey, prefix, hash } = generateApiKey();

  const mockMerchant = {
    id: "merchant-uuid-1",
    name: "Acme Payments",
    email: "billing@acme.com",
    status: "ACTIVE" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockApiKeyRecord = {
    apiKey: {
      id: "key-uuid-1",
      merchantId: "merchant-uuid-1",
      keyPrefix: prefix,
      keyHash: hash,
      scopes: ["payments:read", "payments:write"],
      revokedAt: null,
      createdAt: new Date(),
    },
    merchant: mockMerchant,
  };

  const mockRepo = {
    findActiveApiKeyByPrefix: vi.fn(async (p: string) => {
      if (p === prefix) return mockApiKeyRecord;
      return null;
    }),
    findById: vi.fn(async (id: string) => {
      if (id === mockMerchant.id) return mockMerchant;
      return null;
    }),
    createMerchant: vi.fn(),
    findByEmail: vi.fn(),
    createApiKey: vi.fn(),
    createAccount: vi.fn(),
    findAccountsByMerchantId: vi.fn(),
  } as any;

  function buildProtectedApp() {
    const app = express();
    app.use(express.json());
    app.use(correlationIdMiddleware);

    const auth = createAuthMiddleware(mockRepo);

    app.get("/test/protected", auth, (req, res) => {
      res.status(200).json({
        merchant_id: req.merchant.id,
        merchant_name: req.merchant.name,
        scopes: req.scopes,
      });
    });

    app.get("/test/scoped", auth, requireScope("admin:all"), (req, res) => {
      res.status(200).json({ ok: true });
    });

    app.use(errorHandler);
    return app;
  }

  it("should reject request with 401 when Authorization header is missing", async () => {
    const app = buildProtectedApp();
    const res = await request(app).get("/test/protected");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("should reject request with 401 when key prefix is not found", async () => {
    const app = buildProtectedApp();
    const res = await request(app)
      .get("/test/protected")
      .set("Authorization", "Bearer cw_live_invalidprefix123456");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("should accept valid API key and attach merchant context", async () => {
    const app = buildProtectedApp();
    const res = await request(app)
      .get("/test/protected")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.merchant_id).toBe(mockMerchant.id);
    expect(res.body.merchant_name).toBe(mockMerchant.name);
    expect(res.body.scopes).toEqual(["payments:read", "payments:write"]);
  });

  it("should reject with 403 when merchant lacks required scope", async () => {
    const app = buildProtectedApp();
    const res = await request(app)
      .get("/test/scoped")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  describe("Tenant Isolation Rule (Other tenant = 404, never 403)", () => {
    const service = new MerchantService(mockRepo, {} as any);

    it("should return merchant when tenant queries their own id", async () => {
      const result = await service.getMerchantById("merchant-uuid-1", "merchant-uuid-1");
      expect(result.id).toBe("merchant-uuid-1");
      expect(result.name).toBe("Acme Payments");
    });

    it("should throw NotFoundError (404) when querying another tenant's id", async () => {
      try {
        await service.getMerchantById("merchant-uuid-1", "merchant-uuid-2-other-tenant");
        expect.unreachable("Should have thrown NotFoundError");
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        const appErr = err as NotFoundError;
        expect(appErr.statusCode).toBe(404);
        expect(appErr.code).toBe("NOT_FOUND");
      }
    });
  });
});
