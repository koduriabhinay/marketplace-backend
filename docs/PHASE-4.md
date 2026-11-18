# Phase 4: Caching, queues and reliability — what you built and why

Phase 3 made every request safe. Phase 4 makes the system **fast** (caching), **decoupled**
(events and a worker), and **resilient** when the network or a dependency misbehaves
(timeouts, retries, circuit breakers, idempotency).

## The big picture

```
                    ┌──────────── API (stateless, N copies) ────────────┐
 client ──HTTP────► │ rate limit (Redis) ─► route ─► service ─► Postgres │
                    │                         │ cache-aside (Redis)      │
                    └─────────────────────────┼──────────────────────────┘
                                              │ same transaction
                                              ▼
                                   orders + outbox_events  (Postgres)
                                              │
                    ┌──────────── worker (separate process, N copies) ───────────┐
                    │ outbox relay ──publish (confirms)──► RabbitMQ (topic exch.) │
                    │                                          │ order.*          │
                    │ fan-out consumer ◄──────────────────────┘                  │
                    │       │ INSERT … ON CONFLICT DO NOTHING (idempotent)         │
                    │       ▼                                                      │
                    │ webhook_deliveries ──dispatcher──► seller HTTPS endpoint     │
                    │   (timeout, backoff + jitter, circuit breaker, HMAC signed)  │
                    │ scheduler: cron jobs behind a Postgres advisory lock         │
                    └──────────────────────────────────────────────────────────────┘
```

Placing an order commits to Postgres and returns. Nothing the customer waits on depends on
RabbitMQ or on any seller's server being up.

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Caching | `cache/listingCache.ts` | Cache-aside for the public catalog (read-heavy). Miss → load from Postgres → store with a TTL. Concurrent misses for one key share one DB load (stampede protection). "Not found" isn't cached. Permission checks always read the DB, never the cache. |
| Cache invalidation | `ListingCache.invalidate` | Write to Postgres first, then delete the item key. List results use a **generation number** in the key: any write bumps it, so every cached search becomes unreachable at once without scanning keys. Orders and cancellations invalidate too, because they change stock. TTL bounds staleness if an invalidation is ever missed. |
| Graceful degradation | `ListingCache.safely`, `createRedis` | Redis is an optimisation, not a dependency. Command timeout 500 ms, no offline queue, one retry: if Redis is down, reads fail fast and go to Postgres, and rate limits fail open. `/ready` reports Redis but doesn't fail on it. Tested with Redis pointed at a dead port. |
| Rate limiting (distributed) | `middleware/rateLimit.ts` | Counters in Redis (atomic Lua increment), so the limit holds across every API instance. Tested with two app instances sharing one budget. |
| Stateless services | `app.ts`, `server.ts` | No session, cache or counter lives in an API process, so instances are interchangeable behind a load balancer and can be added or killed freely (Phase 5 scales them). |
| Message queues | `messaging/rabbitBroker.ts` | Topic exchange, durable queues, persistent messages, publisher confirms, manual acks, prefetch for back-pressure, competing consumers. Failed handlers go to a TTL **retry queue**, and after 5 attempts to a **dead-letter queue** for inspection. |
| Transactional outbox | `messaging/events.ts`, `outboxRelay.ts` | The event is written in the same DB transaction as the order, so you never get "order saved, event lost" (or the reverse). A relay publishes unpublished rows with `FOR UPDATE SKIP LOCKED`, so several relays share work without double-publishing. |
| At-least-once + idempotent consumers | `webhooks/webhookFanout.ts` | A crash between publish and commit republishes, so consumers must tolerate duplicates: `UNIQUE (endpoint_id, event_id)` + `ON CONFLICT DO NOTHING`. Webhook receivers get a stable `webhook-id` to de-duplicate too. |
| Background jobs | `worker.ts`, `worker/createWorker.ts`, `jobs/loop.ts` | A separate process from the API, scaled on its own. Polling loops run again immediately while there's work, back off on errors, and finish the current batch on SIGTERM. Crash-only: if RabbitMQ drops, the worker exits and Docker/Kubernetes restarts it. |
| Cron jobs | `jobs/scheduler.ts`, `jobs/maintenance.ts` | Housekeeping (expired refresh tokens, old idempotency keys, published outbox rows, old deliveries). With 3 workers, `pg_try_advisory_lock` makes sure each run happens on exactly one; if that worker dies, Postgres releases the lock. |
| Webhooks | `webhooks/` | Sellers register HTTPS endpoints (secret shown once, encrypted at rest). HMAC-SHA256 signature over `id.timestamp.body`; the signed timestamp blocks replays. Each seller sees only their own order lines. A delivery log shows status, attempts and the last error. |
| Timeouts | dispatcher, `createRedis`, `rabbitBroker.ts`, `lib/retry.ts` | Every outbound call has a deadline: webhooks (`AbortSignal.timeout`), Redis commands, RabbitMQ connect and publish confirms. Without one, a slow dependency ties up your workers until you fall over. |
| Retries with backoff | `lib/retry.ts` | Exponential backoff with **jitter**, so a thousand clients that failed together don't retry together (thundering herd). Full jitter for in-process retries; "equal jitter" for scheduled webhook retries (30 s, 1 min, 2 min … capped at 6 h), then the delivery is marked dead. |
| Circuit breaker | `lib/circuitBreaker.ts` | Per endpoint: after 5 failures in a row it opens and we stop calling for 60 s, then let one trial request through (half-open). Deferred deliveries don't use up attempts. Protects our workers and gives the failing service room to recover. |
| Idempotency | `middleware/idempotency.ts` | `Idempotency-Key` on `POST /orders`. First request runs and stores its response before sending it; a retry replays it (`Idempotent-Replayed: true`); a concurrent duplicate gets 409 + `Retry-After`; the same key with a different body gets 422. 400/429/5xx aren't stored, so the client can fix and retry. Keys are per user. |
| SSRF (bonus) | `webhooks/urlSafety.ts` | A webhook URL makes *our* server send a request. Before each delivery we resolve the host and refuse private, loopback, link-local (cloud metadata at 169.254.169.254) and other reserved ranges, and never follow redirects. |

## Design choices worth defending

- **Why does the API not publish to RabbitMQ directly?** Publishing after the commit can
  fail (lost event); publishing before it can succeed for an order that then rolls back
  (phantom event). The outbox makes the event part of the transaction. As a bonus, the
  API keeps working while RabbitMQ is down; the events just wait in the table.
- **Why Postgres for idempotency keys, not Redis?** They must survive a restart and be
  exact. Redis eviction (`allkeys-lru`) or a flush could silently allow a double order.
- **Why delete cache keys instead of updating them?** Updating the cache from a write
  races with concurrent reads that might put an older value back. Deleting means the next
  read loads the truth. There's still a small window (a read that loaded before the write
  stores after the delete), which the TTL bounds.
- **Why a database-driven retry schedule for webhooks instead of RabbitMQ delays?** Delays
  of hours, a per-delivery log sellers can read, and attempts that survive broker restarts
  are all easier with a table. RabbitMQ handles the fast hop (event → fan-out) and its own
  short retries.
- **Known limitation: DNS rebinding.** We check the address and then `fetch` resolves the
  name again; a hostile DNS server could answer differently the second time. The full fix
  is connecting to the exact IP we checked, or sending webhooks through an egress proxy.

## Try it

```bash
docker compose up -d postgres redis rabbitmq   # or: brew services start redis
# .env: REDIS_URL=redis://localhost:6379  RABBITMQ_URL=amqp://guest:guest@localhost:5672
npm run migrate
npm run dev          # terminal 1: API
npm run dev:worker   # terminal 2: worker

# A throwaway webhook receiver on :4000 (terminal 3)
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.headers['webhook-signature'],b);s.end()})}).listen(4000)"

# As a seller (see the Phase 3 guide to get a token), subscribe to order events:
curl -X POST localhost:3000/api/v1/sellers/<sellerId>/webhooks \
  -H "Authorization: Bearer <sellerToken>" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4000/hook"}'

# As a customer, order twice with the same key: one order, the second is a replay
curl -i -X POST localhost:3000/api/v1/orders -H "Authorization: Bearer <customerToken>" \
  -H 'Idempotency-Key: checkout-123456' -H 'content-type: application/json' \
  -d '{"items":[{"listingId":"<listingId>","quantity":1}]}'
```

Watch the receiver print the signed webhook. With Docker, the RabbitMQ UI is at
http://localhost:15672 (guest/guest) and shows the `webhooks.fanout`, `.retry` and `.dead`
queues.

## Practice questions

1. Cache-aside vs write-through vs write-behind: which did we use, and when would you pick
   each? What is a cache stampede and how do we prevent it?
2. Why does `ListingCache` use a generation number for list keys instead of deleting them?
3. Walk through what happens to an order event if RabbitMQ is down for 10 minutes.
4. Why is our message delivery "at least once", not "exactly once"? How do consumers cope?
5. What is the transactional outbox pattern, and what two bugs does it prevent?
6. Explain exponential backoff, and why jitter matters when many clients fail at once.
7. Draw the circuit breaker states. What happens during half-open?
8. A client times out on `POST /orders`. How does `Idempotency-Key` make the retry safe?
   What should happen if two requests with the same key arrive at the same moment?
9. You have 3 worker replicas. How do you make an hourly job run once, not three times?
10. A seller registers `http://169.254.169.254/latest/meta-data/` as a webhook. What could
    happen, and what stops it here?
11. Redis goes down. What still works, what gets slower, and what would break if we had
    stored idempotency keys in Redis?
