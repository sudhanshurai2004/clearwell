# Clearwell

Payment orchestration + double-entry ledger engine.

> **Simulated provider only.** The PSP in this project is a simulator we build ourselves.
> No real money moves and no real card data is ever handled or stored.
> A real sandbox provider (Stripe/PayPal) can later be added behind the same adapter interface.

## Guarantees this system is built to provide

1. **At most once charged** — a payment is never charged twice, even when clients retry or requests race.
2. **Every state change recorded** — payment state transitions are append-only and auditable.
3. **Ledger always balances** — debits equal credits in every ledger transaction, enforced by the database.
4. **Gaps with the provider detected and repaired** — nightly reconciliation plus a recovery sweeper.

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22 + TypeScript (strict) |
| HTTP | Express |
| Database | PostgreSQL 16 |
| Local infra | Docker Compose |
| Money | `BIGINT` minor units + 3-letter currency code (`number`/float money is banned) |

## Status

**M0 — Environment & repository** (in progress)

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Create your env file
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env

# 3. Start PostgreSQL 16
docker compose up -d
docker ps                     # expect a healthy clearwell-db container

# 4. Typecheck + build + run
npm run typecheck
npm run build
npm start                     # prints: Clearwell API - foundation check OK
```

## Project layout

```
src/
  modules/
    merchant/   # merchants, API keys, auth
    payment/    # payment state machine, authorize/capture/void/refund
    ledger/     # double-entry postings, accounts, balances
    risk/       # rules-based risk checks
    outbox/     # transactional outbox, webhooks
    recon/      # nightly reconciliation vs PSP settlement file
    common/     # errors, logging, config, db helpers
```
