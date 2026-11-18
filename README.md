# Marketplace Backend

A production-style Node.js + TypeScript backend for a small online marketplace: sellers list
products, customers place orders, and background workers handle fulfillment. It is built in
five phases, each adding real-world backend concerns (see `docs/`).

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Foundations: API, validation, errors, health checks, tests | Done |
| 2 | PostgreSQL: migrations, orders, transactions, race conditions | Done |
| 3 | Auth and security: JWT, roles, 2FA, rate limiting, OWASP | Done |
| 4 | Async and resilience: Redis, RabbitMQ, retries, idempotency | Done |
| 5 | Ship and scale: Docker Compose, Nginx, metrics, replicas | Next |

## Quick start

You need PostgreSQL 16. Redis and RabbitMQ are optional for local development: without
`REDIS_URL` / `RABBITMQ_URL` the app uses in-process fallbacks. The easiest way is Docker:

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis rabbitmq   # or just postgres
npm run migrate                 # create/upgrade tables
npm run dev                     # API on http://localhost:3000
npm run dev:worker              # background worker (outbox relay, webhooks, cron jobs)
npm run check                   # lint + typecheck + tests (uses marketplace_test)
```

To also run the Redis and RabbitMQ test suites (CI always does):

```bash
TEST_REDIS_URL=redis://localhost:6379/15 TEST_RABBITMQ_URL=amqp://guest:guest@localhost:5672 npm run check
```

Or run the whole stack (Postgres, Redis, RabbitMQ, migrations, API, worker) in containers. The API container runs
in production mode, so it needs real secrets, passed as Docker secrets:

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/jwt_secret
openssl rand -hex 32 > secrets/encryption_key
docker compose up --build
```

Create the first admin (admins can't self-register):

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run create-admin
```

No Docker? Install Postgres 16 locally (for example `brew install postgresql@16`), then:

```bash
createuser -s marketplace && psql -d postgres -c "ALTER USER marketplace PASSWORD 'marketplace'"
createdb -O marketplace marketplace && createdb -O marketplace marketplace_test
```

Redis without Docker: `brew install redis && brew services start redis`, then set
`REDIS_URL=redis://localhost:6379` in `.env`. RabbitMQ is easiest in Docker; without it the
worker uses an in-process broker, which is fine when the API and worker run on one machine
for development. (Strictly, the API never talks to RabbitMQ: it writes events to Postgres,
and the worker publishes and consumes them.)

Backups: `npm run db:backup` writes a `pg_dump` file to `backups/`;
`npm run db:restore -- backups/<file>.dump` restores it.

## API (v1)

Send `Authorization: Bearer <accessToken>` on endpoints marked 🔒. Roles: `customer`,
`seller`, `admin`.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | `{ email, password, name, role: "customer" \| "seller" }` → user + tokens |
| POST | `/api/v1/auth/login` | → tokens, or `{ mfaRequired, mfaToken }` when 2FA is on |
| POST | `/api/v1/auth/2fa/verify` | `{ mfaToken, code }` → tokens |
| POST | `/api/v1/auth/refresh` | `{ refreshToken }` → new pair (old one stops working) |
| POST | `/api/v1/auth/logout` | `{ refreshToken }` → 204 |
| GET | `/api/v1/auth/me` 🔒 | Current user |
| POST | `/api/v1/auth/2fa/setup` 🔒 | → `{ secret, otpauthUri }` for an authenticator app |
| POST | `/api/v1/auth/2fa/enable` 🔒 | `{ code }` |
| POST | `/api/v1/auth/2fa/disable` 🔒 | `{ code }` |

### Marketplace

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/health`, `/ready` | anyone | Liveness / readiness |
| POST | `/api/v1/sellers` 🔒 | admin | Sellers normally use /auth/register |
| GET | `/api/v1/sellers`, `/:id` | anyone | Public storefronts |
| PATCH | `/api/v1/sellers/:id` 🔒 | that seller, admin | |
| POST | `/api/v1/listings` 🔒 | seller (own), admin | |
| GET | `/api/v1/listings`, `/:id` | anyone | `?sellerId&status&limit&offset` |
| PATCH, DELETE | `/api/v1/listings/:id` 🔒 | owning seller, admin | Delete is soft |
| POST | `/api/v1/listings/:id/images` 🔒 | owning seller, admin | multipart field `image`; JPEG/PNG/WebP ≤ 2 MB |
| GET | `/api/v1/listings/:id/images`, `/:imageId` | anyone | |
| POST | `/api/v1/customers` 🔒 | admin | Customers normally use /auth/register |
| GET | `/api/v1/customers/:id` 🔒 | that customer, admin | |
| POST | `/api/v1/orders` 🔒 | customer (own), admin | 409 `INSUFFICIENT_STOCK`; send `Idempotency-Key` to retry safely |
| GET | `/api/v1/orders`, `/:id` 🔒 | customer (own only), admin | |
| POST | `/api/v1/orders/:id/cancel` 🔒 | customer (own), admin | Returns stock |
| POST | `/api/v1/sellers/:id/webhooks` 🔒 | that seller, admin | `{ url, events? }` → endpoint + signing secret (shown once) |
| GET | `/api/v1/sellers/:id/webhooks` 🔒 | that seller, admin | |
| DELETE | `/api/v1/sellers/:id/webhooks/:webhookId` 🔒 | that seller, admin | |
| GET | `/api/v1/sellers/:id/webhooks/:webhookId/deliveries` 🔒 | that seller, admin | Delivery log: status, attempts, last error |

Webhooks are `POST`ed as JSON with `webhook-id`, `webhook-timestamp` and
`webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">` headers. Verify them with
`verifyWebhook()` in `src/webhooks/signature.ts`. Events: `order.placed`, `order.cancelled`.

Example:

```bash
curl -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"sales@acme.com","password":"correct horse battery staple","name":"Acme","role":"seller"}'
```

Every error has the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...], "requestId": "..." } }
```

## Project layout

```
src/
  auth/          passwords, JWTs, TOTP 2FA, encryption, auth middleware, policies
  cache/         Redis/in-memory cache, listing cache-aside with invalidation
  config/        env loading + validation (fail fast, secrets from files)
  db/            connection pool, transactions, migration runner
  lib/           logger, errors, validation, retry/backoff/timeouts, circuit breaker
  middleware/    error handler, request timeout, rate limiting, idempotency keys
  messaging/     domain events, transactional outbox relay, RabbitMQ + in-memory brokers
  webhooks/      endpoint management, fan-out consumer, signed delivery, SSRF checks
  jobs/          polling loops and cron-style scheduled jobs with a distributed lock
  worker/        wires the background worker together
  storage/       image storage + file-type sniffing
  schemas/       Zod schemas = request contracts + types
  repositories/  data access interfaces + Postgres implementations
  services/      business rules
  routes/        HTTP layer only
  app.ts         builds the Express app from dependencies
  server.ts      starts the API, timeouts, graceful shutdown
  worker.ts      starts the background worker (separate process)
migrations/      versioned SQL schema changes (001_, 002_, ...)
scripts/         backup / restore, least-privilege DB roles
tests/
  unit/          pure logic (config, SQL builders, backoff, circuit breaker, signatures)
  integration/   full HTTP requests via Supertest against a real Postgres
```
