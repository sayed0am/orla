-- Memory Option A (PRD §8): a small curated-facts table, user-controlled, rendered into the
-- cached prompt prefix (see src/memory.ts). The nightly pass may propose rows (status
-- 'proposed', source 'reorganize'); only 'active' facts ever enter a prompt.
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,                     -- one fact, ≤ 200 chars
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','archived')),
  source TEXT NOT NULL,                   -- 'user' | 'reorganize'
  source_note_id TEXT,                    -- organized_notes.id when proposed by the nightly pass
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX memory_facts_status ON memory_facts(status, updated_at);
