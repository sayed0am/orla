-- Web Push subscriptions and the F4 morning brief (PRD F4, §7 Reliability).
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,        -- base64url
  auth TEXT NOT NULL,          -- base64url
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_success_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  for_date TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD (UTC)
  body_md TEXT NOT NULL,
  data TEXT NOT NULL,                   -- JSON of the inputs used
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pushed_at TEXT
);
