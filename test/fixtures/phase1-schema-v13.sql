-- Recorded schema from src/daemon/db.ts at 7e70273 (migrations 1..13).
-- No live database or provider data. Keep fixed when newer migrations are appended.
CREATE TABLE schema_version (v INTEGER NOT NULL);
INSERT INTO schema_version VALUES (13);
CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_id TEXT NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, source_id));
CREATE INDEX events_session_ts ON events (session_id, ts);
CREATE TABLE tail_offsets (path TEXT PRIMARY KEY, ino INTEGER NOT NULL, offset INTEGER NOT NULL);
CREATE TABLE attention (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, source_key TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, kind, source_key));
CREATE INDEX attention_open ON attention (status, session_id);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX outbox_session ON outbox (session_id, id);
CREATE TABLE groups (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE objectives (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX claims_state ON claims (state, resource);
