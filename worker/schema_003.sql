-- Migration 003: email verification.
-- Apply once after schema_002.sql. Safe to apply while EMAIL_VERIFY is off.
-- Existing accounts keep email NULL; with EMAIL_VERIFY=on they are asked to add and verify one at next login.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_lc TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_lc) WHERE email_lc IS NOT NULL;

-- Trusted devices: only an HMAC of the client-held random device id is stored. Written once per verified new device.
CREATE TABLE IF NOT EXISTS devices (
  user_id    TEXT NOT NULL,
  dev_hash   TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (user_id, dev_hash)
);
