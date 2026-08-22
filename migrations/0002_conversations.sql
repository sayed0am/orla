-- D1 holds the conversation INDEX only (for listing); the turns live inside each DO's own
-- SQLite (see src/conversation.ts). PRD F1, PLAN step 5.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX conversations_updated ON conversations(updated_at DESC);
