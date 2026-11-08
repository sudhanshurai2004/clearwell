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
| HTTP | Express 5 |
| Validation | Zod (the Node equivalent of Bean Validation) |
| Database | PostgreSQL 16 |
| Migrations | node-pg-migrate (versioned SQL migrations) |
| Tests | Vitest + Supertest + Testcontainers |
| Logging | pino (structured JSON + redaction) |
| Local infra | Docker Compose |
| Money | `BIGINT` minor units + 3-letter currency code (`number`/float money is banned) |

## Status

| Milestone | State |
| --- | --- |
| M0 Environment & repo | ✅ done |
| M1 Skeleton, migrations, merchants, API-key auth, error handling | 🚧 in progress (1.1–1.4 done) |
| M2+ | pending |

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Create your env file
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env

# 3. Start PostgreSQL 16
docker compose up -d
docker ps                     # expect a healthy clearwell-db container

# 4. Apply migrations
npm run db:migrate

# 5. Run it
npm run dev                   # tsx watch, restarts on save
# or
npm run build && npm start
```

Health endpoints: `GET /healthz` (process alive) and `GET /readyz` (database reachable).

### Tests

```bash
npm test              # everything
npm run test:unit     # no database needed
npm run test:integration
```

Integration tests start their own PostgreSQL 16 via **Testcontainers**, so Docker must be
running. If Docker is unavailable, set `TEST_DATABASE_URL` to a PostgreSQL 16 server and the
suite will create (and drop) a throwaway database per run. Integration tests **never** touch
the database in `DATABASE_URL`.

## API (v1)

All errors use one envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "correlation_id": "…", "details": [] } }
```

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/healthz` | — | liveness |
| GET | `/readyz` | — | readiness (DB round-trip) |
| POST | `/v1/merchants` | — | bootstrap a merchant + first (owner) API key |
| GET | `/v1/merchants/me` | API key | current tenant, derived from the key |
| POST | `/v1/merchants/me/api-keys` | API key + `admin:keys` | issue another key |

### API key format

```
cw_<live|test>_<8 hex prefix>_<32 hex secret>
```

Only the prefix is stored in clear text (it is the lookup key). The full key is stored as
`HMAC-SHA256(key, API_KEY_HASH_SECRET)` and compared in constant time. The raw key is returned
**once**, at creation.

### Quick smoke test

```bash
# 1. create a merchant (returns the raw key exactly once)
curl -s -X POST http://localhost:3000/v1/merchants \
  -H 'content-type: application/json' \
  -d '{"name":"Acme Store","email":"owner@acme.test","default_currency":"USD"}'

# 2. use it
curl -s http://localhost:3000/v1/merchants/me -H "authorization: Bearer cw_live_…"
```

## Repository layout

```
migrations/           versioned SQL migrations (apply in filename order, once, forever)
src/
  app.ts              Express wiring (middleware, routes, error handler)
  server.ts           process bootstrap: config -> pool -> listen -> graceful shutdown
  modules/
    common/           config, logger, errors, ids, money, db helpers
    merchant/         merchants, API keys, auth middleware, scopes
    payment/          payment state machine (M3)
    ledger/           double-entry postings (M2)
    risk/             rules-based risk checks (M9)
    outbox/           transactional outbox + webhooks (M8)
    recon/            reconciliation vs PSP settlement file (M9)
tests/
  unit/               pure logic, no database
  integration/        real Express app + real PostgreSQL
  support/            Testcontainers/Postgres harness
```

## Engineering rules used in this codebase

- **Money** is `bigint` in code and `BIGINT` in SQL, capped at `10^15` minor units so a JSON
  number can never be inexact. Floats are never used for amounts.
- **Tenant isolation**: the merchant id comes only from the API key. Cross-tenant access
  returns **404**, not 403, so existence is not leaked.
- **Errors**: one envelope, one central handler. Unknown errors become a generic 500 with the
  full stack only in the logs.
- **Correlation**: every request has an `x-correlation-id`, echoed in the response and in all
  log lines and error bodies.
- **No long transactions around network calls** (enforced from M3 onward).
