-- gats.io community login — D1 schema (convention)
--
-- Rules of thumb:
--   * Timestamps are unix SECONDS (INTEGER), never strings.
--   * D1 is the durable record. It is written only for signups, renames,
--     logins, failed-login counters, bans, and unregisters. Presence/heartbeats
--     never touch it.
--   * `events` is append-only: INSERT only, never UPDATE/DELETE. user_id is NOT a
--     foreign key on purpose, so history survives account deletion.
--   * Usernames are unique case-insensitively via username_lower.

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,                 -- display name, original casing
  username_lower TEXT    NOT NULL UNIQUE,          -- lookup/uniqueness key
  salt           TEXT    NOT NULL,                 -- per-user PBKDF2 salt (base64url, client-generated)
  kdf_iter       INTEGER NOT NULL DEFAULT 250000,  -- PBKDF2 iterations the client must use
  pw_hash        TEXT    NOT NULL,                 -- SHA-256(client PBKDF2 output), base64url
  banned         INTEGER NOT NULL DEFAULT 0,       -- 1 = cannot log in, live sockets dropped
  token_version  INTEGER NOT NULL DEFAULT 1,       -- bump to revoke every token this user holds
  fail_count     INTEGER NOT NULL DEFAULT 0,       -- consecutive wrong passwords
  locked_until   INTEGER NOT NULL DEFAULT 0,       -- unix sec; logins refused until then
  renamed_at     INTEGER NOT NULL DEFAULT 0,       -- unix sec of last rename (cooldown)
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  user_id INTEGER,                                 -- no FK (see above)
  type    TEXT    NOT NULL,                        -- signup | login | rename | unregister
  detail  TEXT                                     -- small JSON string, e.g. {"from":"a","to":"b"}
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events (ts);
