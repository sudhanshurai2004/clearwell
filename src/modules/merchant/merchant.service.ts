import { Pool } from "pg";
import { pool } from "../common/db";
import { ConflictError, NotFoundError } from "../common/errors";
import { MerchantRepository, merchantRepository } from "./merchant.repository";
import { generateApiKey } from "./merchant.crypto";
import {
  CreateMerchantDto,
  OnboardingResponseDto,
  MerchantResponseDto,
} from "./merchant.types";

export class MerchantService {
  constructor(
    private readonly repo: MerchantRepository = merchantRepository,
    private readonly dbPool: Pool = pool
  ) {}

  async onboard(dto: CreateMerchantDto): Promise<OnboardingResponseDto> {
    const existing = await this.repo.findByEmail(dto.email);
    if (existing) {
      throw new ConflictError(`Merchant with email '${dto.email}' already exists`);
    }

    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");

      // 1. Create merchant record
      const merchant = await this.repo.createMerchant(dto.name, dto.email, client);

      // 2. Provision default MERCHANT_PAYABLE liability account
      const account = await this.repo.createAccount(
        merchant.id,
        "LIABILITY",
        "MERCHANT_PAYABLE",
        dto.currency,
        client
      );

      // 3. Generate high-entropy API key and store its HMAC hash
      const { rawKey, prefix, hash } = generateApiKey();
      const defaultScopes = ["payments:read", "payments:write"];

      const apiKey = await this.repo.createApiKey(
        merchant.id,
        prefix,
        hash,
        defaultScopes,
        client
      );

      await client.query("COMMIT");

      return {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          status: merchant.status,
          created_at: merchant.createdAt.toISOString(),
        },
        api_key: {
          raw_key: rawKey,
          prefix: apiKey.keyPrefix,
          scopes: apiKey.scopes,
          warning: "Store this secret key securely. It will not be shown again.",
        },
        account: {
          id: account.id,
          type: account.type,
          name: account.name,
          currency: account.currency,
          balance: account.balance.toString(),
        },
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getMerchantProfile(merchantId: string): Promise<{
    merchant: MerchantResponseDto;
    accounts: Array<{
      id: string;
      type: string;
      name: string;
      currency: string;
      balance: string;
    }>;
  }> {
    const merchant = await this.repo.findById(merchantId);
    if (!merchant) {
      throw new NotFoundError("Merchant not found");
    }

    const accounts = await this.repo.findAccountsByMerchantId(merchantId);

    return {
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        status: merchant.status,
        created_at: merchant.createdAt.toISOString(),
      },
      accounts: accounts.map((acc) => ({
        id: acc.id,
        type: acc.type,
        name: acc.name,
        currency: acc.currency,
        balance: acc.balance.toString(),
      })),
    };
  }

  async getMerchantById(
    requesterMerchantId: string,
    targetMerchantId: string
  ): Promise<MerchantResponseDto> {
    // Tenant Isolation Enforcement:
    // If querying another tenant's ID, return 404 (NOT 403) to prevent ID enumeration
    if (requesterMerchantId !== targetMerchantId) {
      throw new NotFoundError("Merchant not found");
    }

    const merchant = await this.repo.findById(targetMerchantId);
    if (!merchant) {
      throw new NotFoundError("Merchant not found");
    }

    return {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      status: merchant.status,
      created_at: merchant.createdAt.toISOString(),
    };
  }
}

export const merchantService = new MerchantService();
