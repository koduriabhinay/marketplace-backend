# Phase 5: Ship and scale — what you built and why

Phases 1 to 4 built a correct, secure, resilient service. Phase 5 runs it the way
production does: several copies behind a reverse proxy, HTTPS, a read replica, metrics,
dashboards and alerts, and a pipeline that tests the whole system and publishes an image on
every merge.

## The stack

```
                 :8080 (HTTP → 301)          ┌── api #1 ──┐
 client ──HTTPS──► nginx :8443 ──least_conn──┼── api #2 ──┼──► postgres (primary)  ── WAL stream ──► postgres-replica
                  TLS, rate limit,           └── api #3 ──┘         ▲  writes, txns, auth              ▲ catalog reads
                  image cache, request IDs         │   └──────────────┼───────────────────────────────────┘
                                                   └──► redis (cache, rate limits, read-your-writes markers)
                 worker #1, worker #2 ──► postgres (outbox, deliveries) ──► rabbitmq
 prometheus ──scrapes /metrics──► every api + worker ──► grafana dashboards, alert rules
```

Start it: `docker compose up -d --build`, then `node scripts/smoke.mjs` (see the README).

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Reverse proxy | `deploy/nginx/templates/default.conf.template` | Nginx is the only thing exposed. It terminates TLS, enforces size and time limits, adds request IDs, compresses responses, and hides internal endpoints (`/metrics` → 404). Node never faces slow or malformed clients directly. |
| Load balancing | `upstream api { least_conn; … resolve; }` | Three API replicas behind `least_conn` (fewest in-flight requests wins). `resolve` re-reads Docker DNS every 10 s, so `--scale api=5` is picked up live. Keepalive connections to Node avoid a TCP handshake per request. If a replica dies, `proxy_next_upstream` retries **idempotent** requests on another one; Nginx never retries a POST, so no double orders. Tested: killed a replica mid-traffic, 30/30 requests still returned 200. |
| HTTPS / TLS | Nginx `ssl_*`, `scripts/dev-cert.sh` | TLS 1.2/1.3 only, session cache, HTTP→HTTPS redirect, HSTS controlled at the edge (0 locally, 2 years in production). The smoke test verifies the certificate rather than disabling checks (`NODE_EXTRA_CA_CERTS`). Real certificates come from Let's Encrypt in Phase 7. |
| API gateway | Nginx | The gateway jobs that belong at the edge: per-IP request and connection limits, body size caps, timeouts, request IDs, routing, hiding internal paths. Auth and per-user limits stay in the app, which knows who the user is. Managed gateways (AWS API Gateway, Kong) add API keys, quotas and request transformation. |
| CDN | Nginx `proxy_cache images` | Listing images have random IDs and never change, so they're `Cache-Control: immutable` and cached at the edge for 7 days (`X-Cache-Status: HIT`). `proxy_cache_lock` stops a stampede on a cold image. A real CDN does exactly this in hundreds of locations near users. |
| Read replicas | `db/replicaRouter.ts`, `deploy/postgres/` | A hot standby built with `pg_basebackup` that streams the primary's WAL. Public catalog reads go to it; writes, transactions and permission checks stay on the primary. **Read-your-writes:** every write sets a short "recently written" marker in Redis, and reads of that data go to the primary until the marker expires, so a seller never sees their old listing and stale data never gets cached. If the replica fails, reads fall back to the primary. |
| Scaling | `docker-compose.yml` | Horizontal scaling works because the API is stateless (Phase 4): any replica can serve any request. Workers scale as competing consumers, and `SKIP LOCKED` / advisory locks keep them from stepping on each other. Pool math: replicas × `DB_POOL_MAX` must stay under Postgres `max_connections` (3 × 10 = 30 < 100). Beyond that, add PgBouncer. CPU and memory limits per container make one bad replica unable to starve the rest. |
| Monitoring | `observability/metrics.ts`, `deploy/prometheus/` | RED metrics (rate, errors, duration histogram by **route template**, never raw IDs, to avoid a cardinality explosion), plus saturation: DB pool waiting count, outbox backlog, event-loop lag, memory. Prometheus finds every replica through DNS service discovery. |
| Alerting | `deploy/prometheus/alerts.yml` | Alert on symptoms users feel (5xx rate > 5 %, p95 > 500 ms) and on things about to run out (pool waiting, outbox backlog), each with a `for:` so one bad scrape doesn't page anyone. Alertmanager would route them to Slack or PagerDuty. |
| Dashboards | `deploy/grafana/` | Provisioned as code: data source and a 12-panel "Marketplace overview" (traffic per instance, error rate, p50/p95/p99, slowest routes, pool, cache hit ratio, replica vs primary reads, outbox, webhooks, rate limits, event-loop lag, memory). |
| Logging | Nginx `log_format json`, pino | Both Nginx and the API log JSON with the same `request_id`, which Nginx creates (or keeps from the client) and forwards. One ID traces a request from the edge to the database. In production these go to a log store (Loki, CloudWatch, Datadog). |
| CI/CD | `.github/workflows/ci.yml`, `scripts/smoke.mjs` | CI now boots the entire stack and runs 17 end-to-end checks over HTTPS (TLS, redirect, request IDs, idempotent order, edge image cache, load spread across 3 replicas, outbox published, replica reads, alert rules loaded). Every merge to `main` publishes `ghcr.io/<owner>/marketplace-backend:sha-<commit>` and `:latest`, so a deploy just pulls an exact, tested image. |
| Health checks | compose `healthcheck`, `depends_on` | Startup order is driven by health, not sleeps: replica waits for a healthy primary, migrations run once before any app container, the API waits for the replica and Redis. Liveness (`/health`) and readiness (`/ready`) stay separate; Redis and the replica are reported but optional for readiness. |

## Bug the full stack caught

The `migrate` container had failed since Phase 3: it ran in production mode without the JWT
and encryption secrets, and the config loader correctly refused to start. Unit and
integration tests can't see a wiring bug like that; the end-to-end stack test found it on
its first run. That's the argument for testing the deployed shape of a system, not just
its code.

## Try it

```bash
mkdir -p secrets && openssl rand -hex 32 > secrets/jwt_secret && openssl rand -hex 32 > secrets/encryption_key
./scripts/dev-cert.sh
POSTGRES_PORT=5433 docker compose up -d --build     # 5433: your Homebrew Postgres keeps 5432
NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/smoke.mjs
```

Then:

- Open http://localhost:3030 (admin / admin) → Dashboards → Marketplace → Marketplace overview.
- Generate some traffic: `for i in $(seq 200); do curl -sk https://localhost:8443/api/v1/listings > /dev/null; done`
- Scale out and watch a new line appear in "Requests per second by API instance":
  `POSTGRES_PORT=5433 docker compose up -d --scale api=5 --no-recreate`
- Kill a replica and keep curling: `docker kill marketplace-backend-api-2`. Requests keep succeeding,
  and Prometheus shows the target as down (http://localhost:9090/targets).
- See an image served from the edge cache: upload one, request it twice, compare `X-Cache-Status`.
- Read the request trail: `docker compose logs nginx api | grep <request-id>`

Note: if Redis and RabbitMQ from Phase 4 are already running in Docker, this reuses them.

## Practice questions

1. What does a reverse proxy give you that the Node process can't do well on its own?
2. Round robin vs least connections vs IP hash: when would you pick each? Why don't we
   need sticky sessions?
3. Why is it safe for Nginx to retry a GET on another replica but not a POST? How do
   idempotency keys change that?
4. Where should TLS terminate, and what do you give up by terminating at the proxy?
5. Explain replication lag. How does our read-your-writes marker work, and why must it be
   stored in Redis rather than in each API process?
6. A replica is 30 s behind. What would users notice without our router, and with it?
7. What are the RED and USE methods? Which metrics here belong to each?
8. Why must metric labels never contain user IDs or order IDs?
9. 20 API replicas with `DB_POOL_MAX=10` against Postgres `max_connections=100`: what
   breaks, and how do you fix it?
10. What is the difference between CI and CD? What exactly happens between a merge and a
    new version running?
11. Why build the image once in CI and deploy that exact image, rather than building on the
    server?
