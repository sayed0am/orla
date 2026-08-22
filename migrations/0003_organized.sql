-- Nightly reorganization output (PRD F3): structured notes, extracted action items, and the run
-- bookkeeping/quarantine tables that make a bad pass always recoverable by re-running over raw data.
CREATE TABLE organized_notes (
  id TEXT PRIMARY KEY,
  raw_note_id TEXT NOT NULL UNIQUE REFERENCES raw_notes(id),
  run_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('journal','meeting','task','idea','reference')),
  cleaned_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON array of lowercase strings
  attendees TEXT NOT NULL DEFAULT '[]',   -- JSON array (meetings)
  decisions TEXT NOT NULL DEFAULT '[]',   -- JSON array (meetings)
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX organized_notes_created ON organized_notes(created_at DESC);
CREATE INDEX organized_notes_type ON organized_notes(type);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  organized_note_id TEXT NOT NULL REFERENCES organized_notes(id),
  text TEXT NOT NULL,
  due_date TEXT,                          -- ISO date YYYY-MM-DD or NULL
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX action_items_open ON action_items(due_date) WHERE status = 'open';

CREATE TABLE reorg_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','ok','partial','failed')),
  notes_in INTEGER NOT NULL DEFAULT 0,
  notes_ok INTEGER NOT NULL DEFAULT 0,
  notes_failed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE reorg_quarantine (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  raw_note_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT,                           -- the offending model output, if any
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
