# Clearwell

> **Disclaimer**: Clearwell uses a **simulated provider (PSP Simulator)** built specifically for testing distributed payment edge cases, network drops, provider timeouts, and out-of-order webhooks. No real money or real cardholder data is processed. A real sandbox provider (e.g. Stripe, PayPal) can be plugged in behind the identical adapter interface.

Clearwell is a payment-orchestration learning project built with **Node.js 22, TypeScript (strict), Express, and PostgreSQL 16**. It is not production-ready and must not be used to process real payments.

---

## Core Guarantees

1. **At-Most-Once Charging**: Idempotency keys prevent duplicate payments across network drops and client retries.
2. **Double-Entry Ledger Integrity**: Every monetary movement is recorded as balanced debits and credits (`debits = credits`). Account balances are strictly derived from immutable append-only ledger entries.
3. **Audit Trail & Event Sourcing**: Every state transition is recorded in an append-only `payment_events` table before and after provider interactions.
4. **Recovery and reconciliation prototypes**: Provider timeouts can enter an `UNKNOWN` state, and the repository includes experimental recovery/reconciliation code. Durable background processing and operational recovery are still required.

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
  - `outbox`: Webhook delivery prototype; persistence and guaranteed dispatch are not implemented yet
  - `recon`: Settlement comparison prototype; scheduled and persisted reconciliation is not implemented yet
  - `common`: Centralized error envelope, database pools, logging, and utilities

---

## Project Status

- **Milestone 0 (M0)**: Environment & Project Foundation (Completed) ✅
- **Milestone 1 (M1)**: Skeleton, Migrations, Merchants, API-Key Auth, Tenant Isolation (Completed) ✅
- **Milestone 2 (M2)**: Ledger Core with Balanced-Entry Enforcement (Completed) ✅
- **Milestone 3 (M3)**: Payment State Machine & PSP Simulator (Completed) ✅
- **Milestone 4 (M4)**: Authorize, Capture, Void, Refund Wired to Ledger (Completed) ✅
- **Milestone 5 (M5)**: Idempotency Layer & Conflict Handling (Completed) ✅
- **Milestone 6 (M6)**: Merchant Payouts & Concurrency Control (Completed) ✅
- **Milestone 7 (M7)**: Recovery endpoint and circuit-breaker prototype added; durable scheduled recovery remains.
- **Milestone 8 (M8)**: In-memory webhook/outbox prototype added; Postgres persistence, Kafka, worker delivery, retries, and DLQ remain.
- **Milestone 9 (M9)**: Risk and settlement comparison prototypes added; persistent velocity checks and scheduled reconciliation remain.
- **Milestone 10 (M10)**: Local Docker Compose stack and health checks added; production observability and deployment hardening remain.
- **Milestone 11 (M11)**: Local deployment smoke-tested; CI/CD, production secrets, backups, alerting, and production rollout remain.

### Project limitations

- The PSP is a simulator. No real money or card data is processed.
- The webhook worker is currently a placeholder, and the outbox service stores events in memory. Webhook delivery is therefore not durable or guaranteed.
- Risk velocity input is not yet backed by a persistent rolling-window query.
- Reconciliation currently compares provided data; it is not a scheduled, persisted nightly process.
- Local Docker Compose is for development/testing only. Do not expose it as a production payment service.

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

4. **Start the full local deployment stack**:
   ```bash
   docker compose up --build -d
   ```

5. **Run database migrations and app**:
   ```bash
   npm run migrate:up
   npm run start:prod
   ```

6. **Typecheck and build**:
   ```bash
   npm run typecheck
   npm run build
   ```

7. **Run the development server**:
   ```bash
   npm run dev
   ```

### Deployment commands

```bash
npm run docker:up
npm run docker:logs
npm run docker:down
```

### Health endpoints

- API landing page: `http://localhost:3000/`
- Browser status page: `http://localhost:3000/health`
- Machine-readable health JSON: `http://localhost:3000/health?format=json`
- PSP simulator health: `http://localhost:3001/health`
