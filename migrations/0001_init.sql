-- Raw notes are immutable and canonical (PRD F2/F3, §7 Portability).
CREATE TABLE raw_notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  private INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT
);
CREATE INDEX raw_notes_unprocessed ON raw_notes(created_at) WHERE processed_at IS NULL;

-- Per-call cost log; drives F6 dashboard and G4 cache-hit metric.
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  job_type TEXT NOT NULL,            -- chat | reorganize | brief
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL
);
