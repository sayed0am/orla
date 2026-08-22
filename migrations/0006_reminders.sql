-- F5 reminders: Durable Object alarms fire push notifications for scheduled reminders (PRD F5).
-- D1 is the source of truth; the Scheduler DO (src/reminders.ts) holds no reminder data of its
-- own, only the single alarm timestamp mirroring the earliest `scheduled` row here.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  fire_at TEXT NOT NULL,                 -- ISO UTC
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','fired','cancelled','failed')),
  source TEXT NOT NULL,                  -- 'chat' | 'action_item' | 'manual'
  source_id TEXT,                        -- conversation id / action_item id
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fired_at TEXT
);
CREATE INDEX reminders_due ON reminders(fire_at) WHERE status = 'scheduled';
