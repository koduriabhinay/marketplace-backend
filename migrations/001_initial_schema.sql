-- 001: core marketplace schema (normalized to 3NF).
-- Each entity lives in exactly one table; relationships use foreign keys.

CREATE TABLE sellers (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  email       text NOT NULL CHECK (email = lower(email)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Uniqueness is enforced by the database, not just app code, so two concurrent
-- signups with the same email can't both succeed (app check + DB constraint).
CREATE UNIQUE INDEX sellers_email_key ON sellers (email);

CREATE TABLE customers (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  email       text NOT NULL CHECK (email = lower(email)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_email_key ON customers (email);

CREATE TABLE listings (
  id           uuid PRIMARY KEY,
  seller_id    uuid NOT NULL REFERENCES sellers (id),
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  stock        integer NOT NULL CHECK (stock >= 0),   -- last line of defence against overselling
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz                            -- soft delete
);
-- Partial index: only live rows, matching the "WHERE deleted_at IS NULL" every query uses.
CREATE INDEX listings_seller_live_idx ON listings (seller_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX listings_status_live_idx ON listings (status, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE orders (
  id           uuid PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers (id),
  status       text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'cancelled')),
  total_cents  integer NOT NULL CHECK (total_cents >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);

-- Price is copied onto the line item at purchase time: later price changes to the
-- listing must not rewrite what the customer actually paid.
CREATE TABLE order_items (
  order_id          uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  listing_id        uuid NOT NULL REFERENCES listings (id),
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, listing_id)
);
CREATE INDEX order_items_listing_idx ON order_items (listing_id);
