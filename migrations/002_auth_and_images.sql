-- 002: user accounts, refresh tokens, two-factor auth, listing images.

-- One login account per person. A user is linked to the seller or customer profile they
-- act as; admins have neither. Profiles stay separate from credentials so business data
-- never sits next to password hashes.
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            text NOT NULL CHECK (email = lower(email)),
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('customer', 'seller', 'admin')),
  seller_id        uuid UNIQUE REFERENCES sellers (id),
  customer_id      uuid UNIQUE REFERENCES customers (id),
  -- TOTP secret, encrypted at rest (AES-256-GCM). NULL until 2FA setup starts.
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  -- Last accepted TOTP time step: a code can be used once, never replayed.
  totp_last_step   bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (role = 'seller'   AND seller_id IS NOT NULL AND customer_id IS NULL) OR
    (role = 'customer' AND customer_id IS NOT NULL AND seller_id IS NULL) OR
    (role = 'admin'    AND seller_id IS NULL AND customer_id IS NULL)
  )
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Refresh tokens are opaque random strings. Only their SHA-256 hash is stored, so a
-- database leak doesn't hand out live sessions. Every refresh rotates the token; all
-- tokens from one login share a family_id so reuse of an old token revokes the family.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid REFERENCES refresh_tokens (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Uploaded images are stored on disk under a random name; only metadata lives here.
CREATE TABLE listing_images (
  id            uuid PRIMARY KEY,
  listing_id    uuid NOT NULL REFERENCES listings (id),
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  storage_key   text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_images_listing_idx ON listing_images (listing_id, created_at);
