import { DatabaseSync } from "node:sqlite";
import {
  getDefaultMemorySettings,
  MemoryError,
  MemoryErrorCode,
  type MemoryRecord,
  type MemoryRepository,
  MemoryScope,
  type MemoryScope as MemoryScopeValue,
  type MemorySettings,
  MemorySourceType,
  type StoredMemoryInput,
} from "@pi-harness/memory";
import {
  buildFtsMatchQuery,
  FTS5_UNICODE61_TOKENIZER,
  formatFtsIndexText,
} from "@pi-harness/tools";
import { recordGlobalMemoryVersion } from "./global-memory-version.js";

interface MemoryRow {
  [key: string]: unknown;
}

function requiredString(row: MemoryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error(`Invalid memory value for ${key}`);
  return value;
}

function nullableString(row: MemoryRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Invalid memory value for ${key}`);
  }
  return value;
}

function requiredInteger(row: MemoryRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid memory value for ${key}`);
  }
  return value;
}

function mapMemory(row: MemoryRow): MemoryRecord {
  const scope = requiredString(row, "scope");
  const sourceType = requiredString(row, "source_type");
  if (scope !== MemoryScope.GLOBAL && scope !== MemoryScope.WORKSPACE) {
    throw new Error("Invalid memory scope");
  }
  if (sourceType !== MemorySourceType.MANUAL && sourceType !== MemorySourceType.SESSION) {
    throw new Error("Invalid memory source type");
  }
  if (requiredString(row, "status") !== "saved") {
    throw new Error("Invalid memory status");
  }
  return {
    content: requiredString(row, "content"),
    createdAt: requiredInteger(row, "created_at"),
    id: requiredString(row, "id"),
    revision: requiredInteger(row, "revision"),
    scope,
    sourceSessionId: nullableString(row, "source_session_id"),
    sourceType,
    updatedAt: requiredInteger(row, "updated_at"),
    workspaceId: nullableString(row, "workspace_id"),
  };
}

export class SqliteMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(memory: StoredMemoryInput): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // 跨进程并发写入时在事务内复查唯一内容约束并稳定映射为 DUPLICATE。
      if (this.findDuplicate(memory.normalizedContent, memory.scope, memory.workspaceId)) {
        throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同作用范围的记忆");
      }
      this.database
        .prepare(
          `INSERT INTO memories (
             id, content, normalized_content, scope, workspace_id, status,
             source_type, source_session_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'saved', ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.content,
          memory.normalizedContent,
          memory.scope,
          memory.workspaceId,
          memory.sourceType,
          memory.sourceSessionId,
          memory.revision,
          memory.createdAt,
          memory.updatedAt,
        );
      this.database
        .prepare("INSERT INTO memory_search (memory_id, content) VALUES (?, ?)")
        .run(memory.id, formatFtsIndexText(memory.content));
      // 手动创建的版本也必须能被后续 Run 固定和追溯。
      this.database
        .prepare(`INSERT INTO memory_revisions
          (memory_id, revision, content, applicability, evidence_status, created_at)
          VALUES (?, ?, ?, NULL, 'user_stated', ?)`)
        .run(memory.id, memory.revision, memory.content, memory.updatedAt);
      if (memory.scope === MemoryScope.GLOBAL)
        recordGlobalMemoryVersion(this.database, memory.updatedAt);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public delete(memoryId: string, expectedRevision: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database
        .prepare("SELECT scope FROM memories WHERE id = ? AND revision = ?")
        .get(memoryId, expectedRevision);
      // 全局旧版本仍可能被运行中的快照引用，逻辑删除（status='deleted'）并保留历史版本与来源。
      const deleted =
        current?.scope === MemoryScope.GLOBAL
          ? this.database
              .prepare(
                "UPDATE memories SET status = 'deleted' WHERE id = ? AND revision = ? AND status = 'saved'",
              )
              .run(memoryId, expectedRevision).changes === 1
          : this.database
              .prepare("DELETE FROM memories WHERE id = ? AND revision = ?")
              .run(memoryId, expectedRevision).changes === 1;
      if (deleted) {
        this.database.prepare("DELETE FROM memory_search WHERE memory_id = ?").run(memoryId);
        if (current?.scope === MemoryScope.GLOBAL)
          recordGlobalMemoryVersion(this.database, Date.now());
      }
      this.database.exec("COMMIT");
      return deleted;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public find(memoryId: string): MemoryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM memories WHERE id = ? AND status = 'saved'")
      .get(memoryId);
    return row === undefined ? null : mapMemory(row);
  }

  public findDuplicate(
    normalizedContent: string,
    scope: MemoryScopeValue,
    workspaceId: string | null,
    excludeId?: string,
  ): MemoryRecord | null {
    const row =
      excludeId === undefined
        ? this.database
            .prepare(
              `SELECT * FROM memories
               WHERE normalized_content = ? AND scope = ? AND workspace_id IS ? AND status = 'saved'`,
            )
            .get(normalizedContent, scope, workspaceId)
        : this.database
            .prepare(
              `SELECT * FROM memories
               WHERE normalized_content = ? AND scope = ? AND workspace_id IS ? AND id <> ? AND status = 'saved'`,
            )
            .get(normalizedContent, scope, workspaceId, excludeId);
    return row === undefined ? null : mapMemory(row);
  }

  public getSettings(): MemorySettings {
    const settings = getDefaultMemorySettings();
    const rows = this.database.prepare("SELECT key, value FROM memory_settings").all();
    for (const row of rows) {
      if (row.key === "use_memories") settings.useMemories = row.value === 1;
      if (row.key === "generate_memories") settings.generateMemories = row.value === 1;
    }
    return settings;
  }

  public hasWorkspace(workspaceId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM workspaces WHERE id = ? AND removed_at IS NULL")
        .get(workspaceId) !== undefined
    );
  }

  public list(): readonly MemoryRecord[] {
    return this.database
      .prepare("SELECT * FROM memories WHERE status = 'saved' ORDER BY updated_at DESC, id")
      .all()
      .map(mapMemory);
  }

  // 按 Run 固定的版本读取记忆，历史内容来自不可变版本表。
  private listSnapshotMemories(
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    globalMemories?: readonly MemoryRecord[],
  ): MemoryRecord[] {
    const result: MemoryRecord[] = [...(globalMemories ?? [])];
    const globalIds = new Set(globalMemories?.map((memory) => memory.id));
    for (const [id, revision] of versions) {
      if (globalIds.has(id)) continue;
      const row = this.database
        .prepare(`SELECT m.*, r.content AS version_content, r.created_at AS version_updated_at FROM memories m
        LEFT JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = ?
        WHERE m.id = ? AND (m.scope = 'global' OR m.workspace_id = ?)`)
        .get(revision, id, workspaceId);
      if (!row) continue;
      const memory = mapMemory(row);
      if (typeof row.version_content === "string")
        result.push({
          ...memory,
          revision,
          content: row.version_content,
          updatedAt: Number(row.version_updated_at),
        });
      else if (memory.revision === revision) result.push(memory);
    }
    return result;
  }

  // 在固定版本范围内使用应用层预分词 + 内存 FTS5 unicode61 计算 BM25，后台新增版本不影响本次 Run 排序。
  public searchKeywordSnapshot(
    query: string,
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    limit: number,
    globalMemories?: readonly MemoryRecord[],
  ): readonly MemoryRecord[] {
    const expression = buildFtsMatchQuery(query);
    if (expression === null) return [];
    const memories = this.listSnapshotMemories(workspaceId, versions, globalMemories);
    if (memories.length === 0) return [];
    const index = new DatabaseSync(":memory:");
    try {
      index.exec(
        `CREATE VIRTUAL TABLE snapshot_search USING fts5(
          memory_id UNINDEXED,
          content,
          tokenize='${FTS5_UNICODE61_TOKENIZER}'
        )`,
      );
      const insert = index.prepare(
        "INSERT INTO snapshot_search (memory_id, content) VALUES (?, ?)",
      );
      for (const memory of memories) {
        insert.run(memory.id, formatFtsIndexText(memory.content));
      }
      const rows = index
        .prepare(
          "SELECT memory_id FROM snapshot_search WHERE snapshot_search MATCH ? ORDER BY bm25(snapshot_search), rowid LIMIT ?",
        )
        .all(expression, limit);
      const byId = new Map(memories.map((memory) => [memory.id, memory]));
      return rows.flatMap((row) => {
        const memory = byId.get(String(row.memory_id));
        return memory ? [memory] : [];
      });
    } finally {
      index.close();
    }
  }

  public searchKeywordVisible(
    query: string,
    workspaceId: string,
    limit: number,
  ): readonly MemoryRecord[] {
    const expression = buildFtsMatchQuery(query);
    if (expression === null) return [];
    return this.database
      .prepare(
        `SELECT memories.* FROM memory_search
         JOIN memories ON memories.id = memory_search.memory_id
         WHERE memory_search MATCH ?
           AND memories.status = 'saved'
           AND (memories.scope = 'global' OR memories.workspace_id = ?)
         ORDER BY bm25(memory_search), memories.updated_at DESC
         LIMIT ?`,
      )
      .all(expression, workspaceId, limit)
      .map(mapMemory);
  }

  public update(memory: StoredMemoryInput, expectedRevision: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.database
        .prepare("SELECT scope, content FROM memories WHERE id = ? AND revision = ?")
        .get(memory.id, expectedRevision);
      if (!previous) {
        this.database.exec("COMMIT");
        return false;
      }
      // 跨进程并发下在事务内复查唯一内容约束，避免抛出裸 SQLite 唯一索引错误。
      if (
        this.findDuplicate(memory.normalizedContent, memory.scope, memory.workspaceId, memory.id)
      ) {
        throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同的全局记忆");
      }
      // 先保存旧内容版本，确保已启动的 Run 继续读取固定版本。
      this.database
        .prepare(`INSERT OR IGNORE INTO memory_revisions
          (memory_id, revision, content, applicability, evidence_status, created_at)
          SELECT id, revision, content, NULL, 'user_stated', updated_at FROM memories
          WHERE id = ? AND revision = ?`)
        .run(memory.id, expectedRevision);
      const updated =
        this.database
          .prepare(
            `UPDATE memories SET
               content = ?, normalized_content = ?, scope = ?, workspace_id = ?,
               revision = ?, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            memory.content,
            memory.normalizedContent,
            memory.scope,
            memory.workspaceId,
            memory.revision,
            memory.updatedAt,
            memory.id,
            expectedRevision,
          ).changes === 1;
      if (updated) {
        this.database.prepare("DELETE FROM memory_search WHERE memory_id = ?").run(memory.id);
        this.database
          .prepare("INSERT INTO memory_search (memory_id, content) VALUES (?, ?)")
          .run(memory.id, formatFtsIndexText(memory.content));
        if (previous?.content === memory.content) {
          // 仅调整分类或作用域时保留原有适用条件与证据来源。
          this.database
            .prepare(`INSERT INTO memory_revisions
              (memory_id, revision, content, applicability, evidence_status, created_at)
              SELECT memory_id, ?, content, applicability, evidence_status, ? FROM memory_revisions
              WHERE memory_id = ? AND revision = ?`)
            .run(memory.revision, memory.updatedAt, memory.id, expectedRevision);
          this.database
            .prepare(`INSERT INTO memory_revision_sources
              (memory_id, revision, session_id, run_id, event_id, event_seq)
              SELECT memory_id, ?, session_id, run_id, event_id, event_seq FROM memory_revision_sources
              WHERE memory_id = ? AND revision = ?`)
            .run(memory.revision, memory.id, expectedRevision);
        } else {
          this.database
            .prepare(`INSERT INTO memory_revisions
              (memory_id, revision, content, applicability, evidence_status, created_at)
              VALUES (?, ?, ?, NULL, 'user_stated', ?)`)
            .run(memory.id, memory.revision, memory.content, memory.updatedAt);
        }
        if (previous?.scope === MemoryScope.GLOBAL || memory.scope === MemoryScope.GLOBAL)
          recordGlobalMemoryVersion(this.database, memory.updatedAt);
      }
      this.database.exec("COMMIT");
      return updated;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 保存两个独立的记忆开关，只影响下一次启动的记忆工作。
  public updateSettings(settings: MemorySettings, updatedAt: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.upsertSettings(settings, updatedAt);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertSettings(settings: MemorySettings, updatedAt: number): void {
    const upsert = this.database.prepare(
      `INSERT INTO memory_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    upsert.run("use_memories", Number(settings.useMemories), updatedAt);
    upsert.run("generate_memories", Number(settings.generateMemories), updatedAt);
  }
}
