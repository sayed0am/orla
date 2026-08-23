-- MCP client (PRD §12): remote tool servers and the tap-to-confirm queue for acting tools.
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,                        -- https only
  auth_header TEXT,                         -- full header value e.g. "Bearer …" (stored as-is; single-user, D1 encrypted at rest)
  enabled INTEGER NOT NULL DEFAULT 1,
  schema_json TEXT NOT NULL DEFAULT '[]',   -- SNAPSHOT of tools/list (PRD §12: refreshed only on explicit user action)
  schema_refreshed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','executed','failed','expired')),
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
