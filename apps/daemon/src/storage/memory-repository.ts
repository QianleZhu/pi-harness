import { DatabaseSync } from "node:sqlite";
import {
  getDefaultMemorySettings,
  type MemoryEmbedding,
  type MemoryRecord,
  type MemoryRepository,
  MemoryScope,
  type MemoryScope as MemoryScopeValue,
  type MemorySettings,
  MemorySourceType,
  type StoredMemoryEmbedding,
  type StoredMemoryInput,
  UserProfileFacet,
  type UserProfileFacet as UserProfileFacetValue,
  type VisibleMemoryEmbedding,
} from "@pi-harness/memory";

interface MemoryRow {
  [key: string]: unknown;
}

const PROFILE_FACETS = new Set<string>(Object.values(UserProfileFacet));

function isUserProfileFacet(value: string): value is UserProfileFacetValue {
  return PROFILE_FACETS.has(value);
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
  const profileFacet = nullableString(row, "profile_facet");
  if (scope !== MemoryScope.USER && scope !== MemoryScope.WORKSPACE) {
    throw new Error("Invalid memory scope");
  }
  if (sourceType !== MemorySourceType.MANUAL && sourceType !== MemorySourceType.SESSION) {
    throw new Error("Invalid memory source type");
  }
  if (requiredString(row, "status") !== "saved") {
    throw new Error("Invalid memory status");
  }
  if (profileFacet !== null && !isUserProfileFacet(profileFacet)) {
    throw new Error("Invalid memory profile facet");
  }
  if (
    (scope === MemoryScope.USER && profileFacet === null) ||
    (scope === MemoryScope.WORKSPACE && profileFacet !== null)
  ) {
    throw new Error("Invalid memory profile scope");
  }
  return {
    content: requiredString(row, "content"),
    createdAt: requiredInteger(row, "created_at"),
    id: requiredString(row, "id"),
    profileFacet,
    revision: requiredInteger(row, "revision"),
    scope,
    sourceSessionId: nullableString(row, "source_session_id"),
    sourceType,
    updatedAt: requiredInteger(row, "updated_at"),
    workspaceId: nullableString(row, "workspace_id"),
  };
}

function mapVector(value: unknown, dimensions: number): readonly number[] {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Invalid memory embedding");
  }
  const bytes = Uint8Array.from(value);
  return [...new Float32Array(bytes.buffer)];
}

function vectorBlob(values: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

export class SqliteMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(memory: StoredMemoryInput, embedding: MemoryEmbedding | null): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO memories (
             id, content, normalized_content, profile_facet, scope, workspace_id, status,
             source_type, source_session_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'saved', ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.content,
          memory.normalizedContent,
          memory.profileFacet,
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
        .run(memory.id, memory.content);
      if (embedding) this.insertEmbedding(memory.id, memory.revision, embedding, memory.updatedAt);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public delete(memoryId: string, expectedRevision: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleted =
        this.database
          .prepare("DELETE FROM memories WHERE id = ? AND revision = ?")
          .run(memoryId, expectedRevision).changes === 1;
      if (deleted) {
        this.database.prepare("DELETE FROM memory_search WHERE memory_id = ?").run(memoryId);
      }
      this.database.exec("COMMIT");
      return deleted;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public find(memoryId: string): MemoryRecord | null {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId);
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
               WHERE normalized_content = ? AND scope = ? AND workspace_id IS ?`,
            )
            .get(normalizedContent, scope, workspaceId)
        : this.database
            .prepare(
              `SELECT * FROM memories
               WHERE normalized_content = ? AND scope = ? AND workspace_id IS ? AND id <> ?`,
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

  public isEmbeddingIndexCurrent(modelId: string): boolean {
    const index = this.database
      .prepare("SELECT model_id FROM memory_embedding_settings WHERE singleton = 1")
      .get();
    if (index === undefined || requiredString(index, "model_id") !== modelId) {
      return false;
    }
    return (
      this.database
        .prepare(
          `SELECT 1 FROM memories
           LEFT JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
             AND memory_embeddings.model_id = ?
             AND memory_embeddings.memory_revision = memories.revision
           WHERE memory_embeddings.memory_id IS NULL
           LIMIT 1`,
        )
        .get(modelId) === undefined
    );
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
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC, id")
      .all()
      .map(mapMemory);
  }

  public listVisibleEmbeddings(
    workspaceId: string,
    modelId: string,
  ): readonly VisibleMemoryEmbedding[] {
    return this.database
      .prepare(
        `SELECT memories.*, memory_embeddings.dimensions, memory_embeddings.embedding
         FROM memories
         JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
         WHERE memories.status = 'saved'
           AND (memories.scope = 'user' OR memories.workspace_id = ?)
           AND memory_embeddings.model_id = ?
           AND memory_embeddings.memory_revision = memories.revision
         ORDER BY memories.updated_at DESC, memories.id`,
      )
      .all(workspaceId, modelId)
      .map((row) => ({
        memory: mapMemory(row),
        values: mapVector(row.embedding, requiredInteger(row, "dimensions")),
      }));
  }

  // 按 Run 固定的版本读取记忆，历史内容来自不可变版本表。
  private listSnapshotMemories(
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
  ): MemoryRecord[] {
    const result: MemoryRecord[] = [];
    for (const [id, revision] of versions) {
      const row = this.database
        .prepare(`SELECT m.*, r.content AS version_content, r.created_at AS version_updated_at FROM memories m
        LEFT JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = ?
        WHERE m.id = ? AND (m.scope = 'user' OR m.workspace_id = ?)`)
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

  // 在固定版本范围内查找关键词，保留现有 trigram 匹配方式。
  public searchKeywordSnapshot(
    query: string,
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    limit: number,
  ): readonly MemoryRecord[] {
    const memories = this.listSnapshotMemories(workspaceId, versions);
    if (query.length < 3)
      return memories
        .filter((memory) => memory.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .slice(0, limit);
    const terms = query
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .slice(0, 8);
    const expression = (terms.length ? terms : [query])
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    // 每次按固定版本构建 FTS，后台新增版本不会改变本次 Run 的排序。
    const index = new DatabaseSync(":memory:");
    try {
      index.exec(
        "CREATE VIRTUAL TABLE snapshot_search USING fts5(memory_id UNINDEXED, content, tokenize='trigram')",
      );
      const insert = index.prepare(
        "INSERT INTO snapshot_search (memory_id, content) VALUES (?, ?)",
      );
      for (const memory of memories) insert.run(memory.id, memory.content);
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

  // 从版本化向量索引读取固定版本，当前版本可复用现有索引。
  public listSnapshotEmbeddings(
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    modelId: string,
  ): readonly VisibleMemoryEmbedding[] {
    return this.listSnapshotMemories(workspaceId, versions).flatMap((memory) => {
      const row = this.database
        .prepare(`SELECT dimensions, embedding FROM memory_revision_embeddings
        WHERE memory_id = ? AND revision = ? AND model_id = ?
        UNION ALL SELECT dimensions, embedding FROM memory_embeddings
        WHERE memory_id = ? AND memory_revision = ? AND model_id = ? LIMIT 1`)
        .get(memory.id, memory.revision, modelId, memory.id, memory.revision, modelId);
      return row
        ? [{ memory, values: mapVector(row.embedding, requiredInteger(row, "dimensions")) }]
        : [];
    });
  }

  public replaceEmbeddingIndex(
    modelId: string,
    embeddings: readonly StoredMemoryEmbedding[],
    updatedAt: number,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM memory_embeddings; DELETE FROM memory_embedding_settings;");
      this.database
        .prepare(
          `INSERT INTO memory_embedding_settings
             (singleton, model_id, updated_at) VALUES (1, ?, ?)`,
        )
        .run(modelId, updatedAt);
      for (const embedding of embeddings) {
        this.insertEmbedding(
          embedding.memoryId,
          embedding.memoryRevision,
          embedding,
          embedding.updatedAt,
        );
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public searchKeywordVisible(
    query: string,
    workspaceId: string,
    limit: number,
  ): readonly MemoryRecord[] {
    if (query.length < 3) {
      return this.database
        .prepare(
          `SELECT * FROM memories
           WHERE status = 'saved' AND (scope = 'user' OR workspace_id = ?)
             AND normalized_content LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, id
           LIMIT ?`,
        )
        .all(
          workspaceId,
          `%${query.toLocaleLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
          limit,
        )
        .map(mapMemory);
    }
    const terms = query
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .slice(0, 8);
    const expression = (terms.length ? terms : [query])
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    return this.database
      .prepare(
        `SELECT memories.* FROM memory_search
         JOIN memories ON memories.id = memory_search.memory_id
         WHERE memory_search MATCH ?
           AND memories.status = 'saved'
           AND (memories.scope = 'user' OR memories.workspace_id = ?)
         ORDER BY bm25(memory_search), memories.updated_at DESC
         LIMIT ?`,
      )
      .all(expression, workspaceId, limit)
      .map(mapMemory);
  }

  public update(
    memory: StoredMemoryInput,
    expectedRevision: number,
    embedding?: MemoryEmbedding | null,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated =
        this.database
          .prepare(
            `UPDATE memories SET
               content = ?, normalized_content = ?, profile_facet = ?, scope = ?, workspace_id = ?,
               revision = ?, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            memory.content,
            memory.normalizedContent,
            memory.profileFacet,
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
          .run(memory.id, memory.content);
        if (embedding) {
          this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
          this.insertEmbedding(memory.id, memory.revision, embedding, memory.updatedAt);
        } else if (embedding === null) {
          this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
        } else {
          this.database
            .prepare(
              `UPDATE memory_embeddings SET memory_revision = ?, updated_at = ?
               WHERE memory_id = ? AND memory_revision = ?`,
            )
            .run(memory.revision, memory.updatedAt, memory.id, expectedRevision);
        }
      }
      this.database.exec("COMMIT");
      return updated;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 同时保存记忆开关和 Dreaming 开启代次。
  public updateSettings(settings: MemorySettings, updatedAt: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // 仅在两个开关从不可用变为同时开启时进入新代次。
      const previous = this.getSettings();
      if (
        !(previous.useMemories && previous.generateMemories) &&
        settings.useMemories &&
        settings.generateMemories
      ) {
        this.database
          .prepare(
            `UPDATE app_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ?
           WHERE key = 'dreaming_generation'`,
          )
          .run(updatedAt);
      }
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

  private insertEmbedding(
    memoryId: string,
    memoryRevision: number,
    embedding: MemoryEmbedding,
    updatedAt: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_embeddings (
           memory_id, model_id, dimensions, embedding, memory_revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        embedding.modelId,
        embedding.dimensions,
        vectorBlob(embedding.values),
        memoryRevision,
        updatedAt,
      );
  }
}
