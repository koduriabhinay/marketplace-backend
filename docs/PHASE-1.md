# Phase 1: Foundations — what you built and why

## The request path

```
client → pino-http (request id, log) → helmet (security headers) → express.json (size limit)
       → requestTimeout → router → parse(schema) → service (business rules) → repository (data)
       → response   |  any thrown error → errorHandler → consistent JSON error
```

Each layer has one job. Routes only speak HTTP, services hold business rules, repositories
hide storage. That's why Phase 2 can swap memory for Postgres without touching routes.

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Environment variables | `src/config/env.ts` | Config validated at boot; a bad value crashes immediately instead of failing at 2 AM. |
| Input / server-side validation | `src/schemas/*`, `src/lib/validate.ts` | Zod parses untrusted input into typed data. Strict objects reject unknown fields (mass-assignment protection). |
| HTTP status codes | routes, `src/lib/errors.ts` | 201+Location on create, 204 on delete, 400 bad shape, 404 missing, 409 conflict, 422 valid shape but impossible, 413 too large, 503 timeout/not ready. |
| Error handling | `src/middleware/errorHandler.ts` | Known errors keep their status; unknown errors log in full but return a generic 500 so internals never leak. |
| Automated testing | `tests/` | 36 tests, ~99% coverage; unit tests for rules, Supertest for HTTP. Coverage gate in CI. |
| Stateless services | whole app | No session or cache in process memory that matters across requests, so you can run N copies behind a load balancer. (The in-memory repo is the one exception, and it goes in Phase 2.) |
| Health checks | `src/routes/health.ts` | Liveness (`/health`) vs readiness (`/ready`): restart vs stop sending traffic. |
| Timeouts | `requestTimeout.ts`, `server.ts` | Per-request 503 plus server-level header/keep-alive timeouts. |
| Logging | `src/lib/logger.ts` | Structured JSON, request IDs propagated via `x-request-id`, secrets redacted. |
| Soft deletes | `listingService.remove` | `deletedAt` hides the row but keeps history for orders and audits. |
| Graceful shutdown | `src/server.ts` | On SIGTERM: fail readiness, stop accepting, finish in-flight requests, exit. Zero dropped requests during deploys. |
| Docker, CI/CD | `Dockerfile`, `.github/workflows/ci.yml` | Multi-stage image, non-root user, healthcheck; CI runs lint, typecheck, tests, audit, build. |

## Node.js concepts to understand from this code

- **Event loop:** `requestTimeout` uses `setTimeout`; the timer fires on a later loop turn
  even while other requests are processed. Nothing here blocks the loop (no sync crypto or
  big JSON loops), which is what keeps Node fast under many concurrent requests.
- **async/await + errors:** Express 5 forwards rejected promises from async handlers to the
  error middleware automatically. In Express 4 you'd need a wrapper or every `await` that
  throws would become an unhandled rejection.
- **Closures:** `requestTimeout(ms)` returns a middleware that "remembers" `ms`. Same for the
  router factories that close over their service.
- **Dependency injection:** `createApp(deps)` and services taking `now()` make code testable
  without mocking libraries.

## Practice questions

1. Why return 422 (not 404) when a listing points at a seller that doesn't exist?
2. What's the difference between liveness and readiness probes, and what goes wrong if you
   check the database in the liveness probe?
3. Walk through what happens to an in-flight request when Kubernetes sends SIGTERM.
4. Why store money as integer cents?
5. Why does the in-memory repository return `structuredClone` copies?
6. What is mass assignment and how does `z.strictObject` prevent it?
7. `process.on('unhandledRejection')` — why log and shut down rather than keep running?
8. What would make this service *not* stateless, and why does that matter for scaling?
