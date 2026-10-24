-- D1 convention: durable, rarely written.
-- users  = one row per account (mutable: rename, ban, token_version, lockout counters)
-- events = append-only audit log (never UPDATE or DELETE rows here)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- 32 hex chars, random, never reused, never shown to other players
  username      TEXT NOT NULL,                  -- display name, original casing
  username_lc   TEXT NOT NULL UNIQUE,           -- lowercase form, the uniqueness key
  salt          TEXT NOT NULL,                  -- base64url, 16 bytes, client-chosen PBKDF2 salt
  iter          INTEGER NOT NULL,               -- PBKDF2 iterations the client used
  pw_hash       TEXT NOT NULL,                  -- base64url HMAC-SHA256(PEPPER, client-derived key)
  banned        INTEGER NOT NULL DEFAULT 0,
  ban_reason    TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,     -- bump to revoke every outstanding token
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,     -- epoch ms
  renamed_at    INTEGER NOT NULL DEFAULT 0,     -- epoch ms, for the rename cooldown
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,                    -- epoch ms
  user_id  TEXT,                                -- no FK on purpose: history survives account deletion
  type     TEXT NOT NULL,                       -- signup | login | rename | ban | unban | logout_all | unregister
  detail   TEXT,                                -- short free text / JSON, e.g. {"from":"a","to":"b"}
  ip_hash  TEXT                                 -- truncated HMAC of the IP, never the raw IP
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ip   ON events (type, ip_hash, ts);
