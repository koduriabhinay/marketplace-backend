-- Principle of least privilege for the database.
--
-- Two roles instead of one all-powerful user:
--   marketplace_migrator  owns the schema; used ONLY by `npm run migrate` during deploys.
--   marketplace_app       used by the running API; can read and write rows, nothing else.
--
-- If the API is ever compromised (e.g. via SQL injection), the attacker gets an account
-- that cannot DROP or ALTER tables, create functions, or read other databases.
--
-- Run once as a superuser, after creating the database:
--   psql -d marketplace -v app_password="'change-me'" -v migrator_password="'change-me-too'" \
--        -f scripts/least-privilege.sql

CREATE ROLE marketplace_migrator LOGIN PASSWORD :migrator_password;
CREATE ROLE marketplace_app LOGIN PASSWORD :app_password;

REVOKE ALL ON DATABASE marketplace FROM PUBLIC;
GRANT CONNECT ON DATABASE marketplace TO marketplace_app, marketplace_migrator;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO marketplace_migrator;
GRANT USAGE ON SCHEMA public TO marketplace_app;

-- Tables the migrator creates from now on are automatically usable (rows only) by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE marketplace_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marketplace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE marketplace_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO marketplace_app;

-- The app doesn't need to touch migration bookkeeping.
-- (Run after the first migration:) REVOKE ALL ON schema_migrations FROM marketplace_app;
