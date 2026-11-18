# Marketplace

A production-style Node.js + TypeScript backend for a small online marketplace, with a React
website on top: sellers list products, customers place orders, and background workers
handle fulfillment. It is built in
seven phases, each adding real-world backend concerns (see `docs/`).

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Foundations: API, validation, errors, health checks, tests | Done |
| 2 | PostgreSQL: migrations, orders, transactions, race conditions | Done |
| 3 | Auth and security: JWT, roles, 2FA, rate limiting, OWASP | Done |
| 4 | Async and resilience: Redis, RabbitMQ, retries, idempotency | Done |
| 5 | Ship and scale: Nginx, HTTPS, load balancing, metrics, read replicas, CD | Done |
| 6 | Frontend: React + TypeScript storefront and seller dashboard on this API | Done |
| 7 | Deploy: run it on the public internet (cloud host, domain, real TLS) | Planned |

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

The website (`web/`) runs on Vite and proxies API calls to the API above:

```bash
cd web && npm install
npm run dev                     # http://localhost:5173
npm run check                   # lint + typecheck + component tests
```

Empty shop? `SEED_BASE_URL=http://localhost:3000 node scripts/seed-demo.mjs` adds a demo
seller with a dozen products (it prints the seller's login).

To run every suite against real Redis and RabbitMQ, as CI does (fails instead of skipping
if either service is missing):

```bash
npm run check:full   # Redis DB 15 and RabbitMQ on localhost by default
```

### The full production-like stack

One command runs what production looks like: Nginx (the website, HTTPS, load balancer,
gateway, image cache) in front of 3 API replicas, 2 workers, a Postgres primary plus a streaming read
replica, Redis, RabbitMQ, Prometheus and Grafana. The containers run in production mode,
so they need real secrets (Docker secrets) and a TLS certificate:

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/jwt_secret
openssl rand -hex 32 > secrets/encryption_key
./scripts/dev-cert.sh                       # self-signed cert for https://localhost
docker compose up -d --build                # add POSTGRES_PORT=5433 if Postgres already runs locally
NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/smoke.mjs   # end-to-end check
NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/seed-demo.mjs # optional demo products
(cd web && npm ci && npx playwright install chromium && npx playwright test)   # browser e2e
```

| URL | What |
| --- | --- |
| https://localhost:8443 | The website, and the API under `/api/v1` (http://localhost:8080 redirects here) |
| http://localhost:3030 | Grafana, dashboard "Marketplace overview" (admin / admin) |
| http://localhost:9090 | Prometheus: targets, queries, alerts |
| http://localhost:15672 | RabbitMQ management (guest / guest) |

Scale while it runs: `docker compose up -d --scale api=5 --no-recreate` (Nginx picks up the
new replicas within 10 s). Stop everything: `docker compose down` (add `-v` to wipe data).

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

Browsers send `X-Auth-Transport: cookie` on these calls instead: the refresh token is then
set as an httpOnly, SameSite=Strict cookie scoped to `/api/v1/auth` and left out of the
JSON body, and `refresh` / `logout` take no body (see `docs/PHASE-6.md`).
| GET | `/api/v1/auth/me` 🔒 | Current user |
| POST | `/api/v1/auth/2fa/setup` 🔒 | → `{ secret, otpauthUri }` for an authenticator app |
| POST | `/api/v1/auth/2fa/enable` 🔒 | `{ code }` |
| POST | `/api/v1/auth/2fa/disable` 🔒 | `{ code }` |

### Marketplace

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/health`, `/ready` | anyone | Liveness / readiness |
| GET | `/metrics` | Prometheus (internal) | Blocked at Nginx |
| POST | `/api/v1/sellers` 🔒 | admin | Sellers normally use /auth/register |
| GET | `/api/v1/sellers`, `/:id` | anyone | Public storefronts |
| PATCH | `/api/v1/sellers/:id` 🔒 | that seller, admin | |
| POST | `/api/v1/listings` 🔒 | seller (own), admin | |
| GET | `/api/v1/listings`, `/:id` | anyone | `?sellerId&status&limit&offset`; each listing has `primaryImageUrl` (first photo or null) |
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
  db/            connection pool, transactions, migration runner, read-replica routing
  lib/           logger, errors, validation, retry/backoff/timeouts, circuit breaker
  middleware/    error handler, request timeout, rate limiting, idempotency keys
  observability/ Prometheus metrics
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
web/             the website: React 19 + TypeScript + Vite (see below)
  src/api/       fetch client (in-memory access token, cookie refresh), typed endpoints
  src/auth/      session provider, route guard
  src/cart/      cart reducer + localStorage persistence
  src/pages/     shop, product, cart/checkout, orders, login/register/2FA, seller dashboard
  e2e/           Playwright browser test against the running stack
  Dockerfile     builds the site and bakes it into the Nginx image
migrations/      versioned SQL schema changes (001_, 002_, ...)
deploy/          Nginx, Postgres replication, Prometheus (+ alerts), Grafana (+ dashboard)
scripts/         backup / restore, least-privilege DB roles, dev TLS cert, smoke test, demo seed
tests/
  unit/          pure logic (config, SQL builders, backoff, circuit breaker, signatures)
  integration/   full HTTP requests via Supertest against a real Postgres
```
