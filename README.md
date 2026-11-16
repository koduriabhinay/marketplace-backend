# Marketplace Backend

A production-style Node.js + TypeScript backend for a small online marketplace: sellers list
products, customers place orders, and background workers handle fulfillment. It is built in
five phases, each adding real-world backend concerns (see `docs/`).

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Foundations: API, validation, errors, health checks, tests | Done |
| 2 | PostgreSQL: migrations, orders, transactions, race conditions | Next |
| 3 | Auth and security: JWT, roles, 2FA, rate limiting, OWASP | Planned |
| 4 | Async and resilience: Redis, RabbitMQ, retries, idempotency | Planned |
| 5 | Ship and scale: Docker Compose, Nginx, metrics, replicas | Planned |

## Quick start

```bash
npm install
cp .env.example .env
npm run dev            # http://localhost:3000
npm run check          # lint + typecheck + tests with coverage
```

Or with Docker:

```bash
docker build -t marketplace-backend .
docker run -p 3000:3000 marketplace-backend
```

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
  lib/           logger, error classes, validation helper
  middleware/    error handler, request timeout
  schemas/       Zod schemas = request contracts + types
  repositories/  data access (in-memory now, Postgres in Phase 2)
  services/      business rules
  routes/        HTTP layer only
  app.ts         builds the Express app from dependencies
  server.ts      starts it, timeouts, graceful shutdown
tests/
  unit/          services, config
  integration/   full HTTP requests via Supertest
```
