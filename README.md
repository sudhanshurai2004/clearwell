# Clearwell

> **Disclaimer**: Clearwell uses a **simulated provider (PSP Simulator)** built specifically for testing distributed payment edge cases, network drops, provider timeouts, and out-of-order webhooks. No real money or real cardholder data is processed. A real sandbox provider (e.g. Stripe, PayPal) can be plugged in behind the identical adapter interface.

Clearwell is a production-grade payment orchestration and double-entry ledger engine built with **Node.js 22, TypeScript (strict), Express, and PostgreSQL 16**.

---

## Core Guarantees

1. **At-Most-Once Charging**: Idempotency keys prevent duplicate payments across network drops and client retries.
2. **Double-Entry Ledger Integrity**: Every monetary movement is recorded as balanced debits and credits (`debits = credits`). Account balances are strictly derived from immutable append-only ledger entries.
3. **Audit Trail & Event Sourcing**: Every state transition is recorded in an append-only `payment_events` table before and after provider interactions.
4. **Autonomous Discrepancy Detection & Repair**: Provider timeouts enter an `UNKNOWN` state resolved by background recovery sweepers and nightly reconciliation against provider settlement files.

---

## Tech Stack & Architecture

- **Runtime**: Node.js 22 LTS
- **Language**: TypeScript 5 (Strict Mode, CommonJS)
- **Framework**: Express
- **Database**: PostgreSQL 16 (ACID transactions, row-level locks, deferred constraint triggers)
- **Money Representation**: `BIGINT` minor units (e.g., cents/paise) + ISO 4217 currency code. Floating-point numbers are strictly forbidden.
- **Architecture**: Modular monolith (`clearwell-api`) containing:
  - `merchant`: Tenant onboarding, API key generation & hashing, authentication
  - `payment`: Authorize, capture, void, refund, idempotency orchestration
  - `ledger`: Double-entry append-only ledger, balance queries
  - `risk`: Velocity and amount limit checks
  - `outbox`: Transactional outbox pattern for guaranteed webhook dispatch
  - `recon`: Settlement file reconciliation and discrepancy reporting
  - `common`: Centralized error envelope, database pools, logging, and utilities

---

## Project Status

- **Milestone 0 (M0)**: Environment & Project Foundation (Completed) ✅
- **Milestone 1 (M1)**: Skeleton, Migrations, Merchants, API-Key Auth, Tenant Isolation (Completed) ✅
- **Milestone 2 (M2)**: Ledger Core with Balanced-Entry Enforcement (Completed) ✅
- **Milestone 3 (M3)**: Payment State Machine & PSP Simulator (Completed) ✅
- **Milestone 4 (M4)**: Authorize, Capture, Void, Refund Wired to Ledger (Completed) ✅
- **Milestone 5 (M5)**: Idempotency Layer & Conflict Handling (Next)

---

## Local Development Setup

### Prerequisites
- Node.js >= 20 (v22 LTS recommended)
- npm >= 10
- Docker & Docker Compose

### Quickstart

1. **Clone the repository**:
   ```bash
   git clone https://github.com/sudhanshurai2004/clearwell.git
   cd clearwell
   ```

2. **Configure environment variables**:
   ```powershell
   # On Windows PowerShell:
   Copy-Item .env.example .env

   # On Linux/macOS:
   cp .env.example .env
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Start PostgreSQL database**:
   ```bash
   docker compose up -d
   ```

5. **Typecheck and build**:
   ```bash
   npm run typecheck
   npm run build
   ```

6. **Run the development server**:
   ```bash
   npm run dev
   ```
