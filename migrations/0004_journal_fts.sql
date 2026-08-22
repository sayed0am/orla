-- F7 journal search: FTS5 over organized notes, kept in sync by triggers so a search always
-- reflects the current organized_notes contents without a separate reindex step.
CREATE VIRTUAL TABLE organized_notes_fts USING fts5(
  cleaned_text, summary, tags,
  content='organized_notes', content_rowid='rowid'
);
CREATE TRIGGER organized_notes_ai AFTER INSERT ON organized_notes BEGIN
  INSERT INTO organized_notes_fts(rowid, cleaned_text, summary, tags)
  VALUES (new.rowid, new.cleaned_text, new.summary, new.tags);
END;
CREATE TRIGGER organized_notes_ad AFTER DELETE ON organized_notes BEGIN
  INSERT INTO organized_notes_fts(organized_notes_fts, rowid, cleaned_text, summary, tags)
  VALUES ('delete', old.rowid, old.cleaned_text, old.summary, old.tags);
END;
CREATE TRIGGER organized_notes_au AFTER UPDATE ON organized_notes BEGIN
  INSERT INTO organized_notes_fts(organized_notes_fts, rowid, cleaned_text, summary, tags)
  VALUES ('delete', old.rowid, old.cleaned_text, old.summary, old.tags);
  INSERT INTO organized_notes_fts(rowid, cleaned_text, summary, tags)
  VALUES (new.rowid, new.cleaned_text, new.summary, new.tags);
END;
INSERT INTO organized_notes_fts(organized_notes_fts) VALUES ('rebuild');
