-- D1 schema for the gats.io community login system.
-- Apply with:  npx wrangler d1 execute gcl-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- random UUID, never changes
  username      TEXT NOT NULL,                  -- display name, original casing
  username_lc   TEXT NOT NULL UNIQUE,           -- lowercase, used for uniqueness + login
  pw_hash       TEXT NOT NULL,                  -- pbkdf2$<iterations>$<salt>$<hash>
  banned        INTEGER NOT NULL DEFAULT 0,     -- 1 = cannot log in, tokens rejected
  ban_reason    TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,     -- bump to revoke every outstanding token
  created_at    INTEGER NOT NULL,               -- ms since epoch
  renamed_at    INTEGER                         -- ms since epoch of last rename
);

-- Append-only audit log. Never UPDATE or DELETE rows here.
-- type: register | login | rename | ban | unban | logout_all
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  user_id  TEXT,
  type     TEXT NOT NULL,
  detail   TEXT,
  ip_hash  TEXT                                  -- salted SHA-256 prefix, never the raw IP
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, ts);
