// Crew's database: threads, jobs, messages, events and a small key-value table, in SQLite
// through Node's built-in `node:sqlite` (no dependency). The events table is append-only and
// feeds both the live event stream and the audit trail.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  last_context_tokens INTEGER,
  agent_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rotated_reason TEXT
);
CREATE INDEX IF NOT EXISTS threads_agent ON threads(agent, status);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  thread_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  pid INTEGER,
  result TEXT,
  error TEXT,
  usage TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, priority, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  thread_id INTEGER,
  job_id INTEGER,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent, id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  agent TEXT NOT NULL,
  job_id INTEGER,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT,
  payload TEXT NOT NULL,
  preconditions TEXT NOT NULL,
  risk TEXT,
  tainted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  nonce TEXT,
  note TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reminded_at INTEGER,
  decided_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  push_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER
);
`;

const JSON_COLUMNS = ["payload", "preconditions"];

/** Rows come back with snake_case columns; the hub works in camelCase. */
const camel = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
  );

export class Store {
  /** @param {string} file  a path, or ":memory:" for tests */
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first release, for databases created before them. */
  migrate() {
    const jobColumns = this.db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((c) => c.name);
    if (!jobColumns.includes("tainted")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0");
    }
    const threadColumns = this.db
      .prepare("PRAGMA table_info(threads)")
      .all()
      .map((c) => c.name);
    if (!jobColumns.includes("origin")) {
      // Where the user sent a message from ("pc" or "phone"): a reply buzzes the phone only when
      // the message came from it.
      this.db.exec("ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'pc'");
    }
    const messageColumns = this.db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .map((c) => c.name);
    if (!messageColumns.includes("attachments")) {
      // Files attached to a message, as JSON: [{ id, name, type, size, path, kind }].
      this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
    }
    if (!threadColumns.includes("started")) {
      // Set once Claude Code has created the thread's session, even if that first turn then
      // failed or was stopped: from then on the session must be resumed, not created again.
      this.db.exec("ALTER TABLE threads ADD COLUMN started INTEGER NOT NULL DEFAULT 0");
    }
  }

  close() {
    this.db.close();
  }

  // --- threads

  activeThread(agent) {
    return camel(
      this.db
        .prepare("SELECT * FROM threads WHERE agent = ? AND status = 'active' ORDER BY id DESC")
        .get(agent),
    );
  }

  createThread({ agent, sessionId, createdAt, agentHash }) {
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO threads (agent, session_id, created_at, agent_hash) VALUES (?, ?, ?, ?)",
      )
      .run(agent, sessionId, createdAt, agentHash);
    return this.thread(Number(lastInsertRowid));
  }

  thread(id) {
    return camel(this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id));
  }

  retireThread(id, reason) {
    this.db
      .prepare("UPDATE threads SET status = 'rotated', rotated_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  markThreadStarted(id) {
    this.db.prepare("UPDATE threads SET started = 1 WHERE id = ?").run(id);
  }

  recordTurn(id, contextTokens) {
    this.db
      .prepare(
        "UPDATE threads SET turns = turns + 1, last_context_tokens = COALESCE(?, last_context_tokens) WHERE id = ?",
      )
      .run(contextTokens, id);
  }

  // --- jobs

  addJob({ agent, kind, priority, prompt, createdAt, tainted = false, origin = "pc" }) {
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO jobs (agent, kind, priority, prompt, created_at, tainted, origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(agent, kind, priority, prompt, createdAt, tainted ? 1 : 0, origin);
    return this.job(Number(lastInsertRowid));
  }

  jobsByIds(ids) {
    if (!ids.length) return [];
    const unique = [...new Set(ids.map(Number))];
    return this.db
      .prepare(`SELECT * FROM jobs WHERE id IN (${unique.map(() => "?").join(",")})`)
      .all(...unique)
      .map(camel);
  }

  /** Jobs started since `since` (epoch ms), not counting one kind. */
  countStartedSince(since, exceptKind) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE started_at >= ? AND kind != ?")
      .get(since, exceptKind).n;
  }

  job(id) {
    return camel(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  queuedJobs() {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority, id")
      .all()
      .map(camel);
  }

  jobsWithStatus(status) {
    return this.db.prepare("SELECT * FROM jobs WHERE status = ?").all(status).map(camel);
  }

  /** An agent's jobs created since `since` (epoch ms), oldest first. */
  agentJobsSince(agent, since) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE agent = ? AND created_at >= ? ORDER BY id")
      .all(agent, since)
      .map(camel);
  }

  /** The agent's latest started job, leaving out the quiet bookkeeping runs (skill reviews, look-backs);
   *  a message queued behind a running task doesn't hide it. */
  latestVisibleJob(agent) {
    return camel(
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE agent = ? AND kind NOT IN ('review', 'retro') AND status != 'queued' ORDER BY id DESC",
        )
        .get(agent),
    );
  }

  latestJob(agent) {
    return camel(this.db.prepare("SELECT * FROM jobs WHERE agent = ? ORDER BY id DESC").get(agent));
  }

  /** @param {number} id @param {Record<string, unknown>} fields  camelCase column values */
  updateJob(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())} = ?`);
    this.db
      .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...cols.map((c) => fields[c] ?? null), id);
  }

  // --- messages

  addMessage({ agent, threadId, jobId, role, text, at, attachments }) {
    this.db
      .prepare(
        "INSERT INTO messages (agent, thread_id, job_id, role, text, at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        agent,
        threadId ?? null,
        jobId ?? null,
        role,
        text,
        at,
        attachments?.length ? JSON.stringify(attachments) : null,
      );
  }

  /** The newest `limit` messages for an agent, oldest first. */
  messages(agent, limit = 50, threadId = null) {
    const rows = threadId
      ? this.db
          .prepare(
            "SELECT * FROM messages WHERE agent = ? AND thread_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(agent, threadId, limit)
      : this.db
          .prepare("SELECT * FROM messages WHERE agent = ? ORDER BY id DESC LIMIT ?")
          .all(agent, limit);
    return rows
      .map(camel)
      .map(({ attachments, ...m }) =>
        attachments ? { ...m, attachments: JSON.parse(attachments) } : m,
      )
      .reverse();
  }

  // --- attachments

  addAttachment({ id, name, type, size, path, at }) {
    this.db
      .prepare("INSERT INTO attachments (id, name, type, size, path, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, type, size, path, at);
  }

  attachment(id) {
    return camel(this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(String(id)));
  }

  // --- events

  addEvent(type, data, at) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO events (at, type, data) VALUES (?, ?, ?)")
      .run(at, type, JSON.stringify(data));
    return Number(lastInsertRowid);
  }

  /** Events of one type since `since` (epoch ms), oldest first. */
  eventsOfType(type, since) {
    return this.db
      .prepare("SELECT * FROM events WHERE type = ? AND at >= ? ORDER BY seq")
      .all(type, since)
      .map((row) => ({ seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data) }));
  }

  lastSeq() {
    return this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq;
  }

  eventsSince(seq, limit = 200) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit)
      .map((row) => ({ seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data) }));
  }

  // --- approvals

  addApproval(a) {
    this.db
      .prepare(
        `INSERT INTO approvals (id, code, agent, job_id, type, summary, why, payload, preconditions,
           risk, tainted, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.code,
        a.agent,
        a.jobId ?? null,
        a.type,
        a.summary,
        a.why ?? null,
        JSON.stringify(a.payload),
        JSON.stringify(a.preconditions ?? {}),
        a.risk ?? null,
        a.tainted ? 1 : 0,
        a.createdAt,
        a.expiresAt,
      );
    return this.approval(a.id);
  }

  /** By id or by its short code (codes are unique among pending requests; newest wins). */
  approval(idOrCode) {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ? OR code = ? ORDER BY created_at DESC")
      .get(idOrCode, String(idOrCode).toUpperCase());
    return parseApproval(row);
  }

  approvals(status = null, limit = 100) {
    const rows = status
      ? this.db
          .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, limit)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(parseApproval);
  }

  /** An agent's approvals created since `since` (epoch ms). */
  agentApprovalsSince(agent, since) {
    return this.db
      .prepare("SELECT * FROM approvals WHERE agent = ? AND created_at >= ? ORDER BY created_at")
      .all(agent, since)
      .map(parseApproval);
  }

  updateApproval(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())} = ?`);
    this.db
      .prepare(`UPDATE approvals SET ${sets.join(", ")} WHERE id = ?`)
      .run(...cols.map((c) => fields[c] ?? null), id);
  }

  // --- devices (paired phones; only a hash of each device's key is kept)

  addDevice({ id, name, tokenHash, createdAt }) {
    this.db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, tokenHash, createdAt);
    return this.device(id);
  }

  device(id) {
    return camel(this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id));
  }

  deviceByTokenHash(tokenHash) {
    return camel(
      this.db
        .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
        .get(tokenHash),
    );
  }

  devices() {
    return this.db.prepare("SELECT * FROM devices ORDER BY created_at").all().map(camel);
  }

  updateDevice(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())} = ?`);
    this.db
      .prepare(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`)
      .run(...cols.map((c) => fields[c] ?? null), id);
  }

  // --- key-value

  get(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
}

function parseApproval(row) {
  const a = camel(row);
  if (!a) return a;
  for (const col of JSON_COLUMNS) a[col] = JSON.parse(a[col]);
  a.tainted = Boolean(a.tainted);
  return a;
}
