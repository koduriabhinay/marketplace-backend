# Marketplace Backend

A production-style Node.js + TypeScript backend for a small online marketplace: sellers list
products, customers place orders, and background workers handle fulfillment. It is built in
five phases, each adding real-world backend concerns (see `docs/`).

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Foundations: API, validation, errors, health checks, tests | Done |
| 2 | PostgreSQL: migrations, orders, transactions, race conditions | Done |
| 3 | Auth and security: JWT, roles, 2FA, rate limiting, OWASP | Done |
| 4 | Async and resilience: Redis, RabbitMQ, retries, idempotency | Next |
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

Or run the whole stack (Postgres, migrations, API) in containers. The API container runs
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
| POST | `/api/v1/orders` 🔒 | customer (own), admin | 409 `INSUFFICIENT_STOCK` |
| GET | `/api/v1/orders`, `/:id` 🔒 | customer (own only), admin | |
| POST | `/api/v1/orders/:id/cancel` 🔒 | customer (own), admin | Returns stock |

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
  config/        env loading + validation (fail fast, secrets from files)
  db/            connection pool, transactions, migration runner
  lib/           logger, error classes, validation helper
  middleware/    error handler, request timeout, rate limiting
  storage/       image storage + file-type sniffing
  schemas/       Zod schemas = request contracts + types
  repositories/  data access interfaces + Postgres implementations
  services/      business rules
  routes/        HTTP layer only
  app.ts         builds the Express app from dependencies
  server.ts      starts it, timeouts, graceful shutdown
migrations/      versioned SQL schema changes (001_, 002_, ...)
scripts/         backup / restore, least-privilege DB roles
tests/
  unit/          pure logic (config, SQL builders)
  integration/   full HTTP requests via Supertest against a real Postgres
```
