-- 003: idempotency keys, the transactional outbox, and seller webhooks.

-- Idempotency: a client sends the same Idempotency-Key when it retries a request, and gets
-- the original response back instead of a second order. Keys are scoped to the user so
-- one user can't replay (or block) another's.
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_method   text NOT NULL,
  request_path     text NOT NULL,
  -- SHA-256 of the request body: the same key with a different body is a client bug.
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status  integer,
  response_body    jsonb,
  response_location text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Transactional outbox: events are written in the SAME transaction as the change they
-- describe, so "order saved but event lost" (or the reverse) can't happen. A relay in the
-- worker publishes unpublished rows to RabbitMQ and marks them published.
CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
-- The relay only ever looks for unpublished events, oldest first.
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

-- Sellers register HTTPS endpoints to be told about orders for their listings.
CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY,
  seller_id   uuid NOT NULL REFERENCES sellers (id),
  url         text NOT NULL CHECK (url ~ '^https?://'),
  -- Signing secret, encrypted at rest (we need the plaintext to compute signatures, so
  -- it can't be hashed like a password).
  secret_enc  text NOT NULL,
  events      text[] NOT NULL CHECK (cardinality(events) > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_seller_idx ON webhook_endpoints (seller_id) WHERE active;

-- One row per (endpoint, event): retried with backoff until it succeeds or gives up.
CREATE TABLE webhook_deliveries (
  id                uuid PRIMARY KEY,
  endpoint_id       uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id          uuid NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'dead')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  integer,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  -- A redelivered message from the broker can't create a second delivery (idempotent consumer).
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
