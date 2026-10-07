import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AttentionItem, OutboxMessage, PerspectiveGroup, SbEvent, SendMethod, Session } from "../shared/types.ts";

const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     type TEXT NOT NULL,
     ts INTEGER NOT NULL,
     data TEXT NOT NULL,
     UNIQUE (session_id, source_id)
   )`,
  `CREATE INDEX events_session_ts ON events (session_id, ts)`,
  `CREATE TABLE tail_offsets (
     path TEXT PRIMARY KEY,
     ino INTEGER NOT NULL,
     offset INTEGER NOT NULL
   )`,
  `CREATE TABLE attention (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     source_key TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     data TEXT NOT NULL,
     UNIQUE (session_id, kind, source_key)
   )`,
  `CREATE INDEX attention_open ON attention (status, session_id)`,
  `CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     client_id TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX outbox_session ON outbox (session_id, id)`,
  `CREATE TABLE groups (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  // Append only: migrations are applied by index.
  `CREATE TABLE objectives (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE claims (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     resource TEXT NOT NULL,
     owner TEXT NOT NULL,
     state TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX claims_state ON claims (state, resource)`,
  // p1/authority — append-only; delivery/auth migrations follow this block.
  `CREATE TABLE authority_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE launch_reservations (task_id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  `UPDATE objectives SET data=json_set(data, '$.grant', json('null'));
   UPDATE tasks SET data=json_set(data, '$.historicalVerified', json_object('at', 0, 'reason', 'Legacy verified claim has no eligible recorded evidence'), '$.status', 'finished_unverified') WHERE json_extract(data, '$.status')='verified'`,
  // end p1/authority
  // p1/delivery-auth (after p1/authority)
  // One control path per session, persisted so a restart can't silently switch paths.
  `CREATE TABLE control_locks (session_id TEXT PRIMARY KEY, method TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  // Browser sessions: only the SHA-256 of the cookie secret is stored.
  `CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  // Which root token the daemon last ran with (hash only): a new one revokes older browser sessions.
  `CREATE TABLE auth_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

export class Store {
  readonly db: Database;

  constructor(dataDir: string, file = "switchboard.db") {
    this.db = new Database(file === ":memory:" ? ":memory:" : join(dataDir, file), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
    const row = this.db.query("SELECT v FROM schema_version").get() as { v: number } | null;
    let v = row?.v ?? 0;
    if (!row) this.db.exec("INSERT INTO schema_version (v) VALUES (0)");
    for (; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.query("UPDATE schema_version SET v = ?").run(v + 1);
      })();
    }
  }

  // ---- sessions
  upsertSession(s: Session) {
    this.db
      .query("INSERT INTO sessions (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(s.id, JSON.stringify(s), Date.now());
  }
  loadSessions(): Session[] {
    return (this.db.query("SELECT data FROM sessions").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  deleteSession(id: string) {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ---- events
  /** Insert an event; returns it with id, or null if it was a duplicate. */
  insertEvent(e: SbEvent): SbEvent | null {
    const r = this.db
      .query("INSERT OR IGNORE INTO events (session_id, source_id, type, ts, data) VALUES (?, ?, ?, ?, ?)")
      .run(e.sessionId, e.sourceId, e.type, e.ts, JSON.stringify(e.data));
    if (r.changes === 0) return null;
    return { ...e, id: Number(r.lastInsertRowid) };
  }
  events(sessionId: string, opts: { beforeId?: number; limit?: number } = {}): SbEvent[] {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const rows = (
      opts.beforeId
        ? this.db.query("SELECT * FROM events WHERE session_id = ? AND id < ? ORDER BY ts DESC, id DESC LIMIT ?").all(sessionId, opts.beforeId, limit)
        : this.db.query("SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?").all(sessionId, limit)
    ) as any[];
    return rows.reverse().map((r) => ({ id: r.id, sessionId: r.session_id, sourceId: r.source_id, type: r.type, ts: r.ts, data: JSON.parse(r.data) }));
  }

  /** Match a result to its original, unabridged call, including across daemon restarts. */
  toolCall(sessionId: string, toolUseId: string): Record<string, unknown> | null {
    const row = this.db.query("SELECT data FROM events WHERE session_id = ? AND type = 'tool_call' AND json_extract(data, '$.toolUseId') = ? ORDER BY id DESC LIMIT 1").get(sessionId, toolUseId) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  // ---- attention
  /** Insert unless (session, kind, sourceKey) exists. Returns the stored item or null if duplicate. */
  insertAttention(item: Omit<AttentionItem, "id">): AttentionItem | null {
    const r = this.db
      .query("INSERT OR IGNORE INTO attention (session_id, kind, source_key, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(item.sessionId, item.kind, item.sourceKey, item.status, item.createdAt, JSON.stringify(item));
    if (r.changes === 0) return null;
    const stored = { ...item, id: Number(r.lastInsertRowid) };
    this.updateAttention(stored);
    return stored;
  }
  updateAttention(item: AttentionItem) {
    this.db.query("UPDATE attention SET status = ?, data = ? WHERE id = ?").run(item.status, JSON.stringify(item), item.id);
  }
  openAttention(sessionId?: string): AttentionItem[] {
    const rows = (sessionId
      ? this.db.query("SELECT data FROM attention WHERE status = 'open' AND session_id = ? ORDER BY id").all(sessionId)
      : this.db.query("SELECT data FROM attention WHERE status = 'open' ORDER BY id").all()) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }
  recentAttention(limit = 100): AttentionItem[] {
    return (this.db.query("SELECT data FROM attention ORDER BY id DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  getAttention(id: number): AttentionItem | null {
    const r = this.db.query("SELECT data FROM attention WHERE id = ?").get(id) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  }

  // ---- outbox
  /** Insert a message; if the clientId already exists, return the existing one (idempotent). */
  insertOutbox(m: Omit<OutboxMessage, "id">): { message: OutboxMessage; created: boolean } {
    const existing = this.outboxByClientId(m.clientId);
    if (existing) return { message: existing, created: false };
    const r = this.db
      .query("INSERT INTO outbox (session_id, client_id, state, created_at, data) VALUES (?, ?, ?, ?, ?)")
      .run(m.sessionId, m.clientId, m.state, m.createdAt, JSON.stringify(m));
    const message = { ...m, id: Number(r.lastInsertRowid) };
    this.updateOutbox(message);
    return { message, created: true };
  }
  updateOutbox(m: OutboxMessage) {
    this.db.query("UPDATE outbox SET state = ?, data = ? WHERE id = ?").run(m.state, JSON.stringify(m), m.id);
  }
  outboxByClientId(clientId: string): OutboxMessage | null {
    const r = this.db.query("SELECT data FROM outbox WHERE client_id = ?").get(clientId) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  }
  outboxFor(sessionId: string, limit = 50): OutboxMessage[] {
    return (this.db.query("SELECT data FROM outbox WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(sessionId, limit) as { data: string }[])
      .map((r) => JSON.parse(r.data))
      .reverse();
  }
  outboxById(id: number): OutboxMessage | null {
    const r = this.db.query("SELECT data FROM outbox WHERE id = ?").get(id) as { data: string } | null;
    return r ? JSON.parse(r.data) : null;
  }
  /** Messages for a session that may still be in flight or whose delivery is unknown. */
  unresolvedOutbox(sessionId: string): OutboxMessage[] {
    return (this.db.query("SELECT data FROM outbox WHERE session_id = ? AND state IN ('queued', 'sending', 'uncertain') ORDER BY id").all(sessionId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  // ---- control locks
  loadLocks(): [string, SendMethod][] {
    return (this.db.query("SELECT session_id, method FROM control_locks").all() as { session_id: string; method: SendMethod }[]).map((r) => [r.session_id, r.method]);
  }
  setLock(sessionId: string, method: SendMethod) {
    this.db
      .query("INSERT INTO control_locks (session_id, method, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET method = excluded.method, updated_at = excluded.updated_at")
      .run(sessionId, method, Date.now());
  }
  deleteLock(sessionId: string) {
    this.db.query("DELETE FROM control_locks WHERE session_id = ?").run(sessionId);
  }

  outboxInState(states: string[]): OutboxMessage[] {
    const q = `SELECT data FROM outbox WHERE state IN (${states.map(() => "?").join(",")})`;
    return (this.db.query(q).all(...states) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  // ---- perspective groups
  saveGroup(g: PerspectiveGroup) {
    this.db
      .query("INSERT INTO groups (id, created_at, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
      .run(g.id, g.createdAt, g.status, JSON.stringify(g));
  }
  groups(limit = 100): PerspectiveGroup[] {
    return (this.db.query("SELECT data FROM groups WHERE status != 'dismissed' ORDER BY created_at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  allGroupMemberIds(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.query("SELECT data FROM groups").all() as { data: string }[])
      for (const m of (JSON.parse(r.data) as PerspectiveGroup).members) if (m.sessionId) out.add(m.sessionId);
    return out;
  }

  // ---- tail offsets
  getOffset(path: string): { ino: number; offset: number } | null {
    return (this.db.query("SELECT ino, offset FROM tail_offsets WHERE path = ?").get(path) as any) ?? null;
  }
  setOffset(path: string, ino: number, offset: number) {
    this.db
      .query("INSERT INTO tail_offsets (path, ino, offset) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET ino = excluded.ino, offset = excluded.offset")
      .run(path, ino, offset);
  }
}
