# Marketplace Backend

A production-style Node.js + TypeScript backend for a small online marketplace: sellers list
products, customers place orders, and background workers handle fulfillment. It is built in
five phases, each adding real-world backend concerns (see `docs/`).

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Foundations: API, validation, errors, health checks, tests | Done |
| 2 | PostgreSQL: migrations, orders, transactions, race conditions | Done |
| 3 | Auth and security: JWT, roles, 2FA, rate limiting, OWASP | Next |
| 4 | Async and resilience: Redis, RabbitMQ, retries, idempotency | Planned |
| 5 | Ship and scale: Docker Compose, Nginx, metrics, replicas | Planned |

## Quick start

You need PostgreSQL 16. The easiest way is Docker:

```bash
npm install
cp .env.example .env
docker compose up -d postgres   # Postgres on :5432 with `marketplace` and `marketplace_test` DBs
npm run migrate                 # create/upgrade tables
npm run dev                     # http://localhost:3000
npm run check                   # lint + typecheck + tests (uses marketplace_test)
```

Or run the whole stack (Postgres, migrations, API) in containers:

```bash
docker compose up --build
```

No Docker? Install Postgres 16 locally (for example `brew install postgresql@16`), then:

```bash
createuser -s marketplace && psql -d postgres -c "ALTER USER marketplace PASSWORD 'marketplace'"
createdb -O marketplace marketplace && createdb -O marketplace marketplace_test
```

Backups: `npm run db:backup` writes a `pg_dump` file to `backups/`;
`npm run db:restore -- backups/<file>.dump` restores it.

## API (v1)

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| GET | `/health` | 200 | Liveness |
| GET | `/ready` | 200 / 503 | Readiness (dependencies reachable) |
| POST | `/api/v1/sellers` | 201 | 409 on duplicate email |
| GET | `/api/v1/sellers?limit&offset` | 200 | Paginated |
| GET | `/api/v1/sellers/:id` | 200 | 404 if missing |
| PATCH | `/api/v1/sellers/:id` | 200 | |
| POST | `/api/v1/listings` | 201 | 422 if seller doesn't exist |
| GET | `/api/v1/listings?sellerId&status&limit&offset` | 200 | Filtered, paginated |
| GET | `/api/v1/listings/:id` | 200 | |
| PATCH | `/api/v1/listings/:id` | 200 | Seller can't be changed |
| DELETE | `/api/v1/listings/:id` | 204 | Soft delete |
| POST | `/api/v1/customers` | 201 | 409 on duplicate email |
| GET | `/api/v1/customers/:id` | 200 | |
| POST | `/api/v1/orders` | 201 | 409 `INSUFFICIENT_STOCK`, 422 unknown customer or unavailable listing |
| GET | `/api/v1/orders?customerId&status&limit&offset` | 200 | Items included |
| GET | `/api/v1/orders/:id` | 200 | |
| POST | `/api/v1/orders/:id/cancel` | 200 | Returns stock; 409 if already cancelled |

Example:

```bash
curl -X POST localhost:3000/api/v1/sellers \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"sales@acme.com"}'
```

Every error has the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...], "requestId": "..." } }
```

## Project layout

```
src/
  config/        env loading + validation (fail fast)
  db/            connection pool, transactions, migration runner
  lib/           logger, error classes, validation helper
  middleware/    error handler, request timeout
  schemas/       Zod schemas = request contracts + types
  repositories/  data access interfaces + Postgres implementations
  services/      business rules
  routes/        HTTP layer only
  app.ts         builds the Express app from dependencies
  server.ts      starts it, timeouts, graceful shutdown
migrations/      versioned SQL schema changes (001_, 002_, ...)
scripts/         backup / restore
tests/
  unit/          pure logic (config, SQL builders)
  integration/   full HTTP requests via Supertest against a real Postgres
```
