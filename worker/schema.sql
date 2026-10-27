-- D1 convention: durable, rarely written. Hot state lives in the Room Durable Object.
-- Times are unix epoch milliseconds (INTEGER). Booleans are 0/1.
-- Migrations: add new files schema_002.sql, schema_003.sql ... never edit applied ones.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,            -- random 96-bit, base64url
  login         TEXT NOT NULL UNIQUE,        -- lowercase, IMMUTABLE (also the client KDF salt)
  username      TEXT NOT NULL,               -- display name, renamable, original casing
  username_lc   TEXT NOT NULL UNIQUE,        -- lowercase display name (uniqueness)
  pw_hash       TEXT NOT NULL,               -- HMAC(PEPPER, uid|client_key), base64url
  kdf           TEXT NOT NULL,               -- scheme label, e.g. 'c-pbkdf2-600k+hmac-v1'
  banned        INTEGER NOT NULL DEFAULT 0,
  ban_reason    TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,  -- bump to revoke every token of this user
  created_at    INTEGER NOT NULL
);

-- Append-only. type: register | login | rename | ban | unban
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  type    TEXT NOT NULL,
  data    TEXT,          -- small JSON string
  ip_hash TEXT,          -- truncated SHA-256(ip + secret), not the raw IP
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, at);
