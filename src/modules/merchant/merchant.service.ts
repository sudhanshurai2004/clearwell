import type { Pool } from "pg";
import { withTransaction } from "../common/db";
import { AppError } from "../common/errors";
import { generateApiKey } from "./api-key";
import type {
  ApiKeyResponse,
  CreateApiKeyDto,
  CreateMerchantDto,
  MerchantResponse,
  Scope,
} from "./merchant.dto";
import { SCOPE_VALUES } from "./merchant.dto";
import { MerchantRepository, type MerchantRow } from "./merchant.repository";

/**
 * Business logic lives here; controllers only parse input and shape output.
 * Controllers never see SQL, this class never sees req/res.
 */
export class MerchantService {
  constructor(
    private readonly pool: Pool,
    private readonly apiKeyHashSecret: string,
  ) {}

  /**
   * Merchant + first API key + payable account are created in ONE transaction.
   * A merchant that exists without a key or without a payable account would be
   * an inconsistent tenant, so either all three land or none do.
   */
  async createMerchant(
    dto: CreateMerchantDto,
    options: { live: boolean },
  ): Promise<{ merchant: MerchantResponse; apiKey: ApiKeyResponse }> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const repo = new MerchantRepository(client);
        const merchant = await repo.insertMerchant({
          name: dto.name,
          email: dto.email,
          defaultCurrency: dto.default_currency,
        });
        await repo.ensureMerchantPayableAccount(merchant.id, merchant.default_currency);
        const generated = generateApiKey(options.live, this.apiKeyHashSecret);
        // The bootstrap key is the merchant's OWNER key: it carries every
        // scope, including admin:keys, otherwise nobody could ever mint or
        // rotate a second key (that was a real bug caught by the tests).
        // Least privilege applies to keys the merchant creates later.
        const key = await repo.insertApiKey({
          merchantId: merchant.id,
          keyPrefix: generated.keyPrefix,
          keyHash: generated.keyHash,
          label: "owner",
          scopes: [...SCOPE_VALUES] satisfies readonly Scope[],
        });
        return {
          merchant: toMerchantResponse(merchant),
          apiKey: {
            id: key.id,
            key_prefix: key.key_prefix,
            label: key.label,
            scopes: key.scopes,
            created_at: key.created_at.toISOString(),
            api_key: generated.rawKey,
          },
        };
      });
    } catch (err) {
      if (isUniqueViolation(err, "merchants_email_key")) {
        throw AppError.unprocessable("A merchant with this email already exists");
      }
      throw err;
    }
  }

  async getMerchant(merchantId: string): Promise<MerchantResponse> {
    const repo = new MerchantRepository(this.pool);
    const merchant = await repo.findMerchantById(merchantId);
    if (!merchant) throw AppError.notFound("Merchant not found");
    return toMerchantResponse(merchant);
  }

  /** Issues an additional key for the authenticated merchant. */
  async createApiKey(
    merchantId: string,
    dto: CreateApiKeyDto,
    options: { live: boolean },
  ): Promise<ApiKeyResponse> {
    const repo = new MerchantRepository(this.pool);
    // Key environment follows the deployment, never a hardcoded value.
    // (A test key must not be usable in production and vice versa.)
    const generated = generateApiKey(options.live, this.apiKeyHashSecret);
    const key = await repo.insertApiKey({
      merchantId,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      label: dto.label,
      scopes: dto.scopes,
    });
    return {
      id: key.id,
      key_prefix: key.key_prefix,
      label: key.label,
      scopes: key.scopes,
      created_at: key.created_at.toISOString(),
      api_key: generated.rawKey,
    };
  }
}

function toMerchantResponse(row: MerchantRow): MerchantResponse {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    default_currency: row.default_currency,
    created_at: row.created_at.toISOString(),
  };
}

/** Postgres unique_violation; we map it to a domain error instead of a 500. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code !== "23505") return false;
  return constraint === undefined || pgErr.constraint === constraint;
}
