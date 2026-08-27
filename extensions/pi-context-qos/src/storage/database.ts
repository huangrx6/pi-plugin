import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ContextTier,
  Representation,
  StoredContextItem,
} from "../types.ts";

type Row = Record<string, unknown>;

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function itemFromRow(row: Row): StoredContextItem {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    originEntryId:
      row.origin_entry_id === null ? null : String(row.origin_entry_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    kind: String(row.kind),
    testIdentity:
      row.test_identity === null || row.test_identity === undefined
        ? null
        : String(row.test_identity),
    filePath: row.file_path === null ? null : String(row.file_path),
    createdTurn: Number(row.created_turn),
    lastUsedTurn: Number(row.last_used_turn),
    rawHash: String(row.raw_hash),
    blobHash: row.blob_hash === null ? null : String(row.blob_hash),
    rawTokens: Number(row.raw_tokens),
    activeTokens: Number(row.active_tokens),
    tier: String(row.tier) as ContextTier,
    representation: String(row.representation) as Representation,
    importance: Number(row.importance),
    relevance: Number(row.relevance),
    retentionScore: Number(row.retention_score),
    unresolved: bool(row.unresolved),
    pinned: bool(row.pinned),
    supersededBy:
      row.superseded_by === null ? null : String(row.superseded_by),
    duplicateOf: row.duplicate_of === null ? null : String(row.duplicate_of),
    extractText: String(row.extract_text),
    summaryText: String(row.summary_text),
    searchText: String(row.search_text),
    archived: bool(row.archived),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class ContextDatabase {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(storageDirectory: string) {
    mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
    chmodSync(storageDirectory, 0o700);
    this.path = join(storageDirectory, "context.db");
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        pi_session_path TEXT,
        project_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        context_window INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        frozen INTEGER NOT NULL DEFAULT 0,
        turn INTEGER NOT NULL DEFAULT 0,
        active_task_id TEXT,
        current_epoch INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        created_turn INTEGER NOT NULL,
        closed_turn INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS epochs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        start_turn INTEGER NOT NULL,
        end_turn INTEGER,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        frozen_at INTEGER,
        UNIQUE(session_id, ordinal),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        compressed_bytes INTEGER NOT NULL,
        refs INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        origin_entry_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        test_identity TEXT,
        file_path TEXT,
        created_turn INTEGER NOT NULL,
        last_used_turn INTEGER NOT NULL,
        raw_hash TEXT NOT NULL,
        blob_hash TEXT,
        raw_tokens INTEGER NOT NULL,
        active_tokens INTEGER NOT NULL,
        tier TEXT NOT NULL,
        representation TEXT NOT NULL,
        importance REAL NOT NULL,
        relevance REAL NOT NULL,
        retention_score REAL NOT NULL,
        unresolved INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        duplicate_of TEXT,
        extract_text TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        search_text TEXT NOT NULL,
        archived INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_session_call
        ON context_items(session_id, tool_call_id);
      CREATE INDEX IF NOT EXISTS idx_items_session_turn
        ON context_items(session_id, created_turn);
      CREATE INDEX IF NOT EXISTS idx_items_raw_hash
        ON context_items(raw_hash);
      CREATE INDEX IF NOT EXISTS idx_items_file
        ON context_items(session_id, file_path);
      CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
        item_id UNINDEXED,
        session_id UNINDEXED,
        content,
        tokenize='unicode61'
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(context_items)").all() as Row[];
    if (!columns.some((column) => column.name === "test_identity")) {
      this.db.exec("ALTER TABLE context_items ADD COLUMN test_identity TEXT");
    }
    this.db.exec("PRAGMA user_version=1");
  }

  close(): void {
    this.db.close();
  }

  upsertSession(input: {
    id: string;
    sessionPath: string | null;
    projectRoot: string;
    model: string | null;
    contextWindow: number | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO sessions
          (id, pi_session_path, project_root, created_at, updated_at, model, context_window)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          pi_session_path=excluded.pi_session_path,
          project_root=excluded.project_root,
          updated_at=excluded.updated_at,
          model=excluded.model,
          context_window=excluded.context_window,
          status='active'
      `)
      .run(
        input.id,
        input.sessionPath,
        input.projectRoot,
        now,
        now,
        input.model,
        input.contextWindow,
      );
    this.db
      .prepare(`
        INSERT OR IGNORE INTO epochs (id, session_id, ordinal, start_turn, status)
        VALUES (?, ?, 1, 0, 'active')
      `)
      .run(`${input.id}:epoch:1`, input.id);
  }

  sessionState(sessionId: string): {
    turn: number;
    frozen: boolean;
    currentEpoch: number;
    activeTaskId: string | null;
  } {
    const row = this.db
      .prepare("SELECT turn, frozen, current_epoch, active_task_id FROM sessions WHERE id=?")
      .get(sessionId) as Row | undefined;
    return {
      turn: Number(row?.turn ?? 0),
      frozen: bool(row?.frozen),
      currentEpoch: Number(row?.current_epoch ?? 1),
      activeTaskId:
        row?.active_task_id === null || row?.active_task_id === undefined
          ? null
          : String(row.active_task_id),
    };
  }

  setTurn(sessionId: string, turn: number): void {
    this.db
      .prepare("UPDATE sessions SET turn=?, updated_at=? WHERE id=?")
      .run(turn, Date.now(), sessionId);
  }

  setFrozen(sessionId: string, frozen: boolean): void {
    this.db
      .prepare("UPDATE sessions SET frozen=?, updated_at=? WHERE id=?")
      .run(frozen ? 1 : 0, Date.now(), sessionId);
  }

  upsertTask(sessionId: string, turn: number, objective: string): string {
    const state = this.sessionState(sessionId);
    if (state.activeTaskId) {
      this.db
        .prepare("UPDATE tasks SET title=?, objective=? WHERE id=?")
        .run(objective.slice(0, 120), objective, state.activeTaskId);
      return state.activeTaskId;
    }
    const id = `${sessionId}:task:1`;
    this.db
      .prepare(`
        INSERT OR IGNORE INTO tasks
          (id, session_id, title, objective, status, priority, created_turn)
        VALUES (?, ?, ?, ?, 'active', 100, ?)
      `)
      .run(id, sessionId, objective.slice(0, 120), objective, turn);
    this.db
      .prepare("UPDATE sessions SET active_task_id=? WHERE id=?")
      .run(id, sessionId);
    return id;
  }

  closeEpoch(sessionId: string, turn: number, summary: string): number {
    const state = this.sessionState(sessionId);
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE epochs SET end_turn=?, status='frozen', summary=?, frozen_at=?
        WHERE session_id=? AND ordinal=? AND status='active'
      `)
      .run(turn, summary, now, sessionId, state.currentEpoch);
    const next = state.currentEpoch + 1;
    this.db
      .prepare(`
        INSERT OR IGNORE INTO epochs (id, session_id, ordinal, start_turn, status)
        VALUES (?, ?, ?, ?, 'active')
      `)
      .run(`${sessionId}:epoch:${next}`, sessionId, next, turn + 1);
    this.db
      .prepare("UPDATE sessions SET current_epoch=? WHERE id=?")
      .run(next, sessionId);
    return next;
  }

  recordBlob(hash: string, bytes: number): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO blobs (hash, compressed_bytes, refs, created_at, last_accessed_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET refs=refs+1, last_accessed_at=excluded.last_accessed_at
      `)
      .run(hash, bytes, now, now);
  }

  touchBlob(hash: string): void {
    this.db
      .prepare("UPDATE blobs SET last_accessed_at=? WHERE hash=?")
      .run(Date.now(), hash);
  }

  insertItem(item: StoredContextItem): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT OR REPLACE INTO context_items (
            id, session_id, task_id, origin_entry_id, tool_call_id, tool_name,
            kind, test_identity, file_path, created_turn, last_used_turn, raw_hash, blob_hash,
            raw_tokens, active_tokens, tier, representation, importance,
            relevance, retention_score, unresolved, pinned, superseded_by,
            duplicate_of, extract_text, summary_text, search_text, archived,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `)
        .run(
          item.id,
          item.sessionId,
          item.taskId,
          item.originEntryId,
          item.toolCallId,
          item.toolName,
          item.kind,
          item.testIdentity,
          item.filePath,
          item.createdTurn,
          item.lastUsedTurn,
          item.rawHash,
          item.blobHash,
          item.rawTokens,
          item.activeTokens,
          item.tier,
          item.representation,
          item.importance,
          item.relevance,
          item.retentionScore,
          item.unresolved ? 1 : 0,
          item.pinned ? 1 : 0,
          item.supersededBy,
          item.duplicateOf,
          item.extractText,
          item.summaryText,
          item.searchText,
          item.archived ? 1 : 0,
          item.createdAt,
          item.updatedAt,
        );
      this.db.prepare("DELETE FROM context_fts WHERE item_id=?").run(item.id);
      this.db
        .prepare("INSERT INTO context_fts (item_id, session_id, content) VALUES (?, ?, ?)")
        .run(item.id, item.sessionId, item.searchText);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getItemById(id: string): StoredContextItem | null {
    const row = this.db
      .prepare("SELECT * FROM context_items WHERE id=?")
      .get(id) as Row | undefined;
    return row ? itemFromRow(row) : null;
  }

  getItemByToolCall(sessionId: string, toolCallId: string): StoredContextItem | null {
    const row = this.db
      .prepare("SELECT * FROM context_items WHERE session_id=? AND tool_call_id=?")
      .get(sessionId, toolCallId) as Row | undefined;
    return row ? itemFromRow(row) : null;
  }

  listItems(sessionId: string): StoredContextItem[] {
    return (
      this.db
        .prepare("SELECT * FROM context_items WHERE session_id=? ORDER BY created_turn, created_at")
        .all(sessionId) as Row[]
    ).map(itemFromRow);
  }

  listItemsBySessionPath(sessionPath: string): StoredContextItem[] {
    return (
      this.db
        .prepare(`
          SELECT c.* FROM context_items c
          JOIN sessions s ON s.id=c.session_id
          WHERE s.pi_session_path=?
          ORDER BY c.created_turn, c.created_at
        `)
        .all(sessionPath) as Row[]
    ).map(itemFromRow);
  }

  findDuplicate(rawHash: string): StoredContextItem | null {
    const row = this.db
      .prepare(`
        SELECT * FROM context_items
        WHERE raw_hash=? AND archived=1
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(rawHash) as Row | undefined;
    return row ? itemFromRow(row) : null;
  }

  latestFileItem(sessionId: string, filePath: string): StoredContextItem | null {
    const row = this.db
      .prepare(`
        SELECT * FROM context_items
        WHERE session_id=? AND file_path=?
        ORDER BY created_turn DESC, created_at DESC LIMIT 1
      `)
      .get(sessionId, filePath) as Row | undefined;
    return row ? itemFromRow(row) : null;
  }

  markSuperseded(oldId: string, newId: string): void {
    this.db
      .prepare(`
        UPDATE context_items
        SET superseded_by=?, tier='historical', updated_at=? WHERE id=?
      `)
      .run(newId, Date.now(), oldId);
  }

  resolveOlderTests(itemIds: string[], newItemId: string): void {
    const statement = this.db.prepare(`
      UPDATE context_items
      SET unresolved=0, tier='historical', superseded_by=?, updated_at=?
      WHERE id=? AND unresolved=1
    `);
    for (const id of itemIds) statement.run(newItemId, Date.now(), id);
  }

  setRepresentation(
    id: string,
    representation: Representation,
    activeTokens: number,
    score: number,
    relevance: number,
  ): void {
    this.db
      .prepare(`
        UPDATE context_items SET representation=?, active_tokens=?,
          retention_score=?, relevance=?, last_used_turn=last_used_turn,
          updated_at=? WHERE id=?
      `)
      .run(representation, activeTokens, score, relevance, Date.now(), id);
  }

  setPinned(id: string, pinned: boolean): boolean {
    const result = this.db
      .prepare(`
        UPDATE context_items SET pinned=?, tier=CASE WHEN ?=1 THEN 'pinned' ELSE tier END,
          updated_at=? WHERE id=?
      `)
      .run(pinned ? 1 : 0, pinned ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  touchItem(id: string, turn: number): void {
    this.db
      .prepare("UPDATE context_items SET last_used_turn=?, updated_at=? WHERE id=?")
      .run(turn, Date.now(), id);
  }

  search(sessionId: string, query: string, limit = 10): StoredContextItem[] {
    const rows = this.db
      .prepare(`
        SELECT c.* FROM context_fts f
        JOIN context_items c ON c.id=f.item_id
        WHERE f.session_id=? AND context_fts MATCH ?
        ORDER BY bm25(context_fts), c.created_turn DESC LIMIT ?
      `)
      .all(sessionId, query, limit) as Row[];
    return rows.map(itemFromRow);
  }

  listEpochs(sessionId: string): Row[] {
    return this.db
      .prepare(
        "SELECT ordinal, start_turn, end_turn, status, summary FROM epochs WHERE session_id=? ORDER BY ordinal",
      )
      .all(sessionId) as Row[];
  }

  listTasks(sessionId: string): Row[] {
    return this.db
      .prepare(
        "SELECT id, title, objective, status, priority, created_turn, closed_turn FROM tasks WHERE session_id=? ORDER BY created_turn",
      )
      .all(sessionId) as Row[];
  }

  activeTaskObjective(sessionId: string): string {
    const row = this.db
      .prepare(`
        SELECT t.objective FROM sessions s
        LEFT JOIN tasks t ON t.id=s.active_task_id
        WHERE s.id=?
      `)
      .get(sessionId) as Row | undefined;
    return typeof row?.objective === "string" ? row.objective : "";
  }

  storageBytes(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(compressed_bytes), 0) AS bytes FROM blobs")
      .get() as Row;
    return Number(row.bytes);
  }

  resetSession(sessionId: string): void {
    const ids = this.db
      .prepare("SELECT id FROM context_items WHERE session_id=?")
      .all(sessionId) as Row[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of ids) {
        this.db.prepare("DELETE FROM context_fts WHERE item_id=?").run(String(row.id));
      }
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteExpiredItems(cutoff: number): number {
    const rows = this.db
      .prepare(`
        SELECT id FROM context_items
        WHERE updated_at<? AND pinned=0 AND unresolved=0
      `)
      .all(cutoff) as Row[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const id = String(row.id);
        this.db.prepare("DELETE FROM context_fts WHERE item_id=?").run(id);
        this.db.prepare("DELETE FROM context_items WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  orphanBlobs(): Array<{ hash: string; bytes: number }> {
    return this.db
      .prepare(`
        SELECT b.hash, b.compressed_bytes AS bytes
        FROM blobs b LEFT JOIN context_items c ON c.blob_hash=b.hash
        WHERE c.id IS NULL
        ORDER BY b.last_accessed_at ASC
      `)
      .all() as Array<{ hash: string; bytes: number }>;
  }

  blobLru(): Array<{ hash: string; bytes: number }> {
    return this.db
      .prepare(`
        SELECT b.hash, b.compressed_bytes AS bytes FROM blobs b
        WHERE NOT EXISTS (
          SELECT 1 FROM context_items c
          WHERE c.blob_hash=b.hash AND (c.pinned=1 OR c.unresolved=1)
        )
        ORDER BY b.last_accessed_at ASC
      `)
      .all() as Array<{ hash: string; bytes: number }>;
  }

  detachBlob(hash: string): void {
    this.db
      .prepare("UPDATE context_items SET blob_hash=NULL, archived=0 WHERE blob_hash=?")
      .run(hash);
    this.db.prepare("DELETE FROM blobs WHERE hash=?").run(hash);
  }
}
