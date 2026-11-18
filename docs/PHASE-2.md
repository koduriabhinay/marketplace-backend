# Phase 2: Real database — what you built and why

Data now lives in PostgreSQL. Routes and services barely changed: only the repository
layer was swapped, which is exactly what the Phase 1 layering was for.

## Schema (normalized)

```
sellers 1──* listings 1──* order_items *──1 orders *──1 customers
```

Each fact lives in one place. An order's line items are their own table (not a JSON blob),
so you can query "how many units of listing X sold?" with an index, and foreign keys stop
an order from pointing at a customer that doesn't exist.

## The core lesson: placing an order without overselling

Two buyers, one item left:

```
Buyer A: read stock = 1 ─┐                 ┌─ write stock = 0
Buyer B: read stock = 1 ─┘  both see 1!    └─ write stock = 0   → sold twice
```

`src/repositories/postgres/orders.ts` fixes this with:

1. **A transaction** — check stock, decrement it, insert the order and items: all or nothing.
2. **`SELECT ... FOR UPDATE`** — locks the listing rows. Buyer B's query *waits* until A
   commits, then reads the new stock (0) and gets a 409.
3. **Locking in a fixed order (`ORDER BY id`)** — prevents deadlocks when two orders contain
   the same listings in different orders.
4. **`CHECK (stock >= 0)`** — the database refuses negative stock even if code has a bug.

The test `prevents overselling under concurrent orders` fires 20 simultaneous orders at a
listing with 5 in stock and asserts exactly 5 succeed. Remove `FOR UPDATE` and watch it fail.

Cancelling uses the same idea: the order row is locked so five simultaneous cancel
requests restock exactly once.

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Database migrations | `migrations/`, `src/db/migrate.ts` | Versioned, forward-only SQL files, each in a transaction, tracked in `schema_migrations`, guarded by an advisory lock so two instances can't migrate at once. Run as a separate deploy step, not on app boot. |
| Normalization | `001_initial_schema.sql` | 3NF tables with foreign keys. Price is deliberately *copied* onto `order_items`: that's historical fact, not duplication. |
| Indexing | migration + `database.test.ts` | Indexes match real queries (`seller_id, created_at DESC`); *partial* indexes `WHERE deleted_at IS NULL` stay small. Verified with `EXPLAIN`. |
| Soft deletes | `listings.deleted_at` | Orders still reference deleted listings, so rows are hidden, not removed. |
| Connection pooling | `src/db/pool.ts` | Bounded pool (`DB_POOL_MAX`), connect timeout, `statement_timeout`; pool closed on graceful shutdown. Instances × pool size must fit Postgres `max_connections`. |
| Race conditions | `orders.ts` | Row locks + transaction + CHECK constraint; unique indexes catch duplicate signups that slip past the app-level check. |
| SQL injection | every query | Only bind parameters (`$1`); dynamic column names come from a hard-coded whitelist (`buildSet`). Tested with a `DROP TABLE` payload. |
| Backups | `scripts/backup.sh`, `restore.sh` | `pg_dump` custom format; restore in a single transaction. A backup is only real once you've restored it. |
| Timeouts | pool config | `statement_timeout` kills runaway queries; `connectionTimeoutMillis` fails fast if the pool is exhausted. |
| Error mapping | services | Postgres codes become HTTP: 23505 unique → 409, 23503 foreign key → 422. |
| N+1 queries | `SELECT_ORDERS` | Orders and their items come back in one query using `json_agg`, not one query per order. |

## Practice questions

1. Walk through what happens when two requests try to buy the last unit. Where exactly does
   the second one wait?
2. Why lock rows in `ORDER BY id` order? Describe the deadlock you'd get otherwise.
3. Optimistic vs pessimistic locking: when would you use a `version` column instead of
   `FOR UPDATE`? (Hint: an atomic `UPDATE ... SET stock = stock - 1 WHERE stock >= 1` is a third option.)
4. Why is there both an app-level duplicate-email check and a unique index?
5. Why copy `unit_price_cents` into `order_items` instead of joining to `listings.price_cents`?
6. What is a partial index and why does it suit soft deletes?
7. Your API runs 6 instances with `DB_POOL_MAX=10`. Postgres allows 100 connections. What breaks
   when you scale to 12 instances, and what are the fixes (PgBouncer, smaller pools)?
8. Why run migrations as a separate step instead of on app startup? What about rolling deploys
   where old and new code run at the same time (expand/contract migrations)?
9. What's the difference between `pg_dump` backups and point-in-time recovery (WAL archiving)?
