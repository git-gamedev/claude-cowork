-- Migration 002: persist the 24-hour rename cooldown.
-- Apply once after the original schema.sql on an existing database.
-- A default of 0 lets existing accounts rename once immediately after deployment.
ALTER TABLE users ADD COLUMN renamed_at INTEGER NOT NULL DEFAULT 0;
