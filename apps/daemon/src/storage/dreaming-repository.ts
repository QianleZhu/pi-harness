import type { DatabaseSync } from "node:sqlite";
import {
  type DreamingMemoryChange,
  type DreamingRunStatus,
  type GlobalDreamingMemoryChange,
  MemoryEvidenceStatus,
  MemoryRecordSchema,
  type MemoryRevision,
  type MemoryRevisionSource,
  type RunMemorySnapshot,
  DreamingRunStatus as RunStatus,
  resolveDreamingRevision,
} from "@pi-harness/memory";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { recordGlobalMemoryVersion } from "./global-memory-version.js";

// Dreaming 调度记录与候选共同保存，避免状态和候选分离。
export interface DreamingRunRecord {
  runId: string;
  workspaceId: string;
  sessionId: string;
  startGeneration: number;
  status: DreamingRunStatus;
  candidatesJson: string | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
}

export interface DreamingWikiRecord {
  workspaceId: string;
  directoryId: string;
  updatedAt: number;
}

// 将 SQLite 的版本数据映射到领域类型。
function mapRevision(row: Record<string, unknown>): MemoryRevision {
  const evidenceStatus = row.evidence_status;
  if (
    typeof evidenceStatus !== "string" ||
    !Object.values(MemoryEvidenceStatus).some((value) => value === evidenceStatus)
  ) {
    throw new Error("Invalid memory evidence status");
  }
  return {
    memoryId: String(row.memory_id),
    revision: Number(row.revision),
    content: String(row.content),
    applicability: row.applicability === null ? null : String(row.applicability),
    evidenceStatus: evidenceStatus as MemoryRevision["evidenceStatus"],
    createdAt: Number(row.created_at),
  };
}

// 管理 Dreaming 的版本、来源、发布指针和 Run 记录。
export class SqliteDreamingRepository {
  public constructor(private readonly database: DatabaseSync) {}

  // 在同一读取事务中固定 Wiki、上下文指针和所有可见记忆的版本。
  public captureSnapshot(workspaceId: string): RunMemorySnapshot {
    this.database.exec("BEGIN");
    try {
      const wikiDirectoryId = this.findWiki(workspaceId)?.directoryId ?? null;
      const wikiVersionRow = wikiDirectoryId
        ? this.database
            .prepare(
              "SELECT version FROM dreaming_wiki_versions WHERE workspace_id = ? AND directory_id = ?",
            )
            .get(workspaceId, wikiDirectoryId)
        : undefined;
      if (wikiDirectoryId && !wikiVersionRow) throw new Error("Dreaming Wiki version not found");
      const context = this.findContext(workspaceId);
      const contextVersion = context
        ? this.findContextVersion(workspaceId, context.directoryId)
        : null;
      if (context && contextVersion === null) throw new Error("Dreaming context version not found");
      const rows = this.database
        .prepare(`SELECT id, revision FROM memories
        WHERE status = 'saved' AND (scope = 'user' OR workspace_id = ?)`)
        .all(workspaceId);
      const versions = new Map(rows.map((row) => [String(row.id), Number(row.revision)]));
      const global = this.getGlobalVersion();
      const workspaceRow = this.database
        .prepare(`SELECT COALESCE(json_group_array(json_object(
        'id', id, 'content', content, 'profileFacet', profile_facet, 'scope', scope,
        'workspaceId', workspace_id, 'sourceType', source_type, 'sourceSessionId', source_session_id,
        'revision', revision, 'createdAt', created_at, 'updatedAt', updated_at)), '[]') AS memories_json
        FROM memories WHERE scope = 'workspace' AND workspace_id = ? AND status = 'saved'`)
        .get(workspaceId);
      if (!workspaceRow || typeof workspaceRow.memories_json !== "string")
        throw new Error("Invalid workspace snapshot");
      const workspaceMemories: unknown = JSON.parse(workspaceRow.memories_json);
      if (!Value.Check(Type.Array(MemoryRecordSchema), workspaceMemories))
        throw new Error("Invalid workspace snapshot");
      this.database.exec("COMMIT");
      return {
        workspaceId,
        contextDirectoryId: context?.directoryId ?? null,
        contextVersion,
        wikiDirectoryId,
        wikiVersion: wikiVersionRow ? Number(wikiVersionRow.version) : null,
        versions,
        globalVersion: global.version,
        globalMemories: global.memories,
        workspaceMemories: workspaceMemories as import("@pi-harness/memory").MemoryRecord[],
      };
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 读取当前 user 记忆发布版本及其不可变副本。
  public getGlobalVersion(): {
    version: number;
    memories: import("@pi-harness/memory").MemoryRecord[];
  } {
    const row = this.database
      .prepare(
        "SELECT version, memories_json FROM global_memory_versions ORDER BY version DESC LIMIT 1",
      )
      .get();
    if (!row || typeof row.memories_json !== "string")
      throw new Error("Global memory version not found");
    const memories: unknown = JSON.parse(row.memories_json);
    if (!Value.Check(Type.Array(MemoryRecordSchema), memories))
      throw new Error("Invalid global memory version");
    return {
      version: Number(row.version),
      memories: memories as import("@pi-harness/memory").MemoryRecord[],
    };
  }

  // 原子提交全局草案、来源、索引和发布副本。
  public publishGlobal(input: {
    expectedVersion: number;
    changes: readonly GlobalDreamingMemoryChange[];
    now: number;
  }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.getGlobalVersion().version !== input.expectedVersion) {
        this.database.exec("ROLLBACK");
        return false;
      }
      let changed = false;
      for (const change of input.changes) {
        const content = change.content.trim().replaceAll(/\s+/g, " ");
        if (!content || content.length > 500 || !change.sources.length)
          throw new Error("Invalid global memory change");
        let revision = 1;
        if (change.expectedRevision === null) {
          this.database
            .prepare(`INSERT INTO memories
            (id, content, normalized_content, profile_facet, scope, workspace_id, status, source_type, source_session_id, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'user', NULL, 'saved', 'session', ?, 1, ?, ?)`)
            .run(
              change.memoryId,
              content,
              content.toLocaleLowerCase(),
              change.profileFacet,
              change.sources[0]?.sessionId ?? null,
              input.now,
              input.now,
            );
        } else {
          const current = this.database
            .prepare("SELECT * FROM memories WHERE id = ? AND scope = 'user' AND status = 'saved'")
            .get(change.memoryId);
          if (!current || current.revision !== change.expectedRevision)
            throw new Error("Global memory revision conflict");
          this.database
            .prepare(`INSERT OR IGNORE INTO memory_revisions
            (memory_id, revision, content, applicability, evidence_status, created_at)
            VALUES (?, ?, ?, NULL, 'user_stated', ?)`)
            .run(
              change.memoryId,
              change.expectedRevision,
              String(current.content),
              Number(current.updated_at),
            );
          this.database
            .prepare(`INSERT OR IGNORE INTO memory_revision_embeddings
            (memory_id, revision, model_id, dimensions, embedding)
            SELECT memory_id, memory_revision, model_id, dimensions, embedding FROM memory_embeddings
            WHERE memory_id = ? AND memory_revision = ?`)
            .run(change.memoryId, change.expectedRevision);
          revision = resolveDreamingRevision(
            change,
            { content: String(current.content), revision: change.expectedRevision },
            this.findRevision(change.memoryId, change.expectedRevision),
            this.listSources(change.memoryId, change.expectedRevision),
          );
          if (revision === change.expectedRevision && current.profile_facet !== change.profileFacet)
            revision++;
          if (revision === change.expectedRevision) continue;
          this.database
            .prepare(
              "UPDATE memories SET content = ?, normalized_content = ?, profile_facet = ?, revision = ?, updated_at = ? WHERE id = ?",
            )
            .run(
              content,
              content.toLocaleLowerCase(),
              change.profileFacet,
              revision,
              input.now,
              change.memoryId,
            );
          this.database
            .prepare("DELETE FROM memory_search WHERE memory_id = ?")
            .run(change.memoryId);
          this.database
            .prepare("DELETE FROM memory_embeddings WHERE memory_id = ?")
            .run(change.memoryId);
        }
        changed = true;
        this.database
          .prepare("INSERT INTO memory_search (memory_id, content) VALUES (?, ?)")
          .run(change.memoryId, content);
        this.createRevision({
          memoryId: change.memoryId,
          revision,
          content,
          applicability: change.applicability,
          evidenceStatus: change.evidenceStatus,
          createdAt: input.now,
        });
        if (change.expectedRevision !== null)
          this.database
            .prepare(`INSERT INTO memory_revision_sources
          (memory_id, revision, session_id, run_id, event_id, event_seq)
          SELECT memory_id, ?, session_id, run_id, event_id, event_seq FROM memory_revision_sources WHERE memory_id = ? AND revision = ?`)
            .run(revision, change.memoryId, change.expectedRevision);
        for (const source of change.sources)
          this.database
            .prepare(`INSERT OR IGNORE INTO memory_revision_sources
          (memory_id, revision, session_id, run_id, event_id, event_seq) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              change.memoryId,
              revision,
              source.sessionId,
              source.runId,
              source.eventId,
              source.eventSeq,
            );
      }
      if (changed) recordGlobalMemoryVersion(this.database, input.now);
      this.database.exec("COMMIT");
      return true;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 读取持久化的开启代次。
  public getGeneration(): number {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = 'dreaming_generation'")
      .get();
    const generation = Number(row?.value);
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("Invalid Dreaming generation");
    return generation;
  }

  // 读取独立 Dreaming 模型；未配置时调度器保持待处理状态。
  public getModel(): { providerId: string; modelId: string } | null {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = 'dreaming_model'")
      .get();
    if (!row) return null;
    if (typeof row.value !== "string") throw new Error("Invalid Dreaming model setting");
    const value: unknown = JSON.parse(row.value);
    if (
      typeof value !== "object" ||
      value === null ||
      !("providerId" in value) ||
      !("modelId" in value) ||
      typeof value.providerId !== "string" ||
      !value.providerId ||
      typeof value.modelId !== "string" ||
      !value.modelId
    ) {
      throw new Error("Invalid Dreaming model setting");
    }
    return { providerId: value.providerId, modelId: value.modelId };
  }

  // 保存或清除 Dreaming 专用模型。
  public setModel(model: { providerId: string; modelId: string } | null, updatedAt: number): void {
    if (model === null) {
      this.database.prepare("DELETE FROM app_settings WHERE key = 'dreaming_model'").run();
      return;
    }
    this.database
      .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('dreaming_model', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(model), updatedAt);
  }

  // 在 Run 开始时仅检查生成记忆开关，关闭时新 Run 不进入待整理队列。
  public recordRunStart(input: {
    runId: string;
    workspaceId: string;
    sessionId: string;
    timestamp: number;
  }): void {
    const settings = this.database.prepare("SELECT key, value FROM memory_settings").all();
    const enabled = (key: string) => settings.find((row) => row.key === key)?.value !== 0;
    if (!enabled("generate_memories")) return;
    this.database
      .prepare(`INSERT OR IGNORE INTO dreaming_runs
      (run_id, workspace_id, session_id, start_generation, status, candidates_json, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`)
      .run(
        input.runId,
        input.workspaceId,
        input.sessionId,
        this.getGeneration(),
        RunStatus.WAITING,
        input.timestamp,
        input.timestamp,
      );
  }

  // 已登记的 Run 结束时正常转为待整理；中途关闭开关不影响已开始的 Run，只阻止后续启动新的整理。
  public recordRunEnd(runId: string, timestamp: number): void {
    const run = this.findRun(runId);
    if (!run || run.status !== RunStatus.WAITING) return;
    this.database
      .prepare(
        "UPDATE dreaming_runs SET status = ?, finished_at = ?, updated_at = ? WHERE run_id = ? AND status = ?",
      )
      .run(RunStatus.PENDING, timestamp, timestamp, runId, RunStatus.WAITING);
  }

  // 按 Session 分组并按启动顺序读取待处理 Run，供单个工作区 Agent 依次处理。
  public listPendingRuns(): DreamingRunRecord[] {
    const rows = this.database
      .prepare(
        "SELECT run_id FROM dreaming_runs WHERE status = ? ORDER BY session_id, started_at, run_id",
      )
      .all(RunStatus.PENDING);
    return rows.flatMap((row) => {
      const run = this.findRun(String(row.run_id));
      return run ? [run] : [];
    });
  }

  // 同一事务领取待整理的 Run，避免重复启动整理 Agent。
  public claimPendingRuns(
    runIds: readonly string[],
    workspaceId: string,
    updatedAt: number,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        "UPDATE dreaming_runs SET status = ?, candidates_json = NULL, updated_at = ? WHERE run_id = ? AND workspace_id = ? AND status = ?",
      );
      for (const runId of runIds) {
        if (
          update.run(RunStatus.CONSOLIDATING, updatedAt, runId, workspaceId, RunStatus.PENDING)
            .changes !== 1
        ) {
          this.database.exec("ROLLBACK");
          return false;
        }
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 本批整理失败时同步清除候选并终结所有 Run。
  public failConsolidation(runIds: readonly string[], updatedAt: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        "UPDATE dreaming_runs SET status = ?, candidates_json = NULL, updated_at = ? WHERE run_id = ? AND status = ?",
      );
      for (const runId of runIds)
        update.run(RunStatus.FAILED, updatedAt, runId, RunStatus.CONSOLIDATING);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 无需更新记忆时原子完成整批 Run 并清除候选。
  public completeConsolidation(runIds: readonly string[], updatedAt: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        "UPDATE dreaming_runs SET status = ?, candidates_json = NULL, updated_at = ? WHERE run_id = ? AND status = ?",
      );
      for (const runId of runIds) {
        if (
          update.run(RunStatus.COMPLETED, updatedAt, runId, RunStatus.CONSOLIDATING).changes !== 1
        )
          throw new Error("Dreaming batch is not consolidating");
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 查询尚未观察到结束事件的 Run，供启动恢复核对 JSONL。
  public listWaitingRuns(): DreamingRunRecord[] {
    const rows = this.database
      .prepare("SELECT run_id FROM dreaming_runs WHERE status = ?")
      .all(RunStatus.WAITING);
    return rows.flatMap((row) => {
      const run = this.findRun(String(row.run_id));
      return run ? [run] : [];
    });
  }

  // 标记无法在 Session JSONL 中恢复的 Run。
  public skipWaitingRun(runId: string, updatedAt: number): void {
    this.database
      .prepare(
        "UPDATE dreaming_runs SET status = ?, updated_at = ? WHERE run_id = ? AND status = ?",
      )
      .run(RunStatus.SKIPPED, updatedAt, runId, RunStatus.WAITING);
  }

  // 重启时终结中断的后台调用，未开始的分析仍保留待调度状态。
  public failInterrupted(updatedAt: number): void {
    this.database
      .prepare(
        "UPDATE dreaming_runs SET status = ?, candidates_json = NULL, updated_at = ? WHERE status IN (?, ?)",
      )
      .run(RunStatus.FAILED, updatedAt, RunStatus.ANALYZING, RunStatus.CONSOLIDATING);
  }

  // 写入新的记忆版本，不覆盖已有版本。
  public createRevision(revision: MemoryRevision): void {
    this.database
      .prepare(`INSERT INTO memory_revisions
      (memory_id, revision, content, applicability, evidence_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        revision.memoryId,
        revision.revision,
        revision.content,
        revision.applicability,
        revision.evidenceStatus,
        revision.createdAt,
      );
  }

  // 按版本读取摘要。
  public findRevision(memoryId: string, revision: number): MemoryRevision | null {
    const row = this.database
      .prepare("SELECT * FROM memory_revisions WHERE memory_id = ? AND revision = ?")
      .get(memoryId, revision);
    return row === undefined ? null : mapRevision(row);
  }

  // 将事件关联到记忆版本。
  public addSource(source: MemoryRevisionSource): void {
    this.database
      .prepare(`INSERT INTO memory_revision_sources
      (memory_id, revision, session_id, run_id, event_id, event_seq) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        source.memoryId,
        source.revision,
        source.sessionId,
        source.runId,
        source.eventId,
        source.eventSeq,
      );
  }

  // 读取记忆版本关联的事件来源。
  public listSources(memoryId: string, revision: number): MemoryRevisionSource[] {
    return this.database
      .prepare(
        "SELECT * FROM memory_revision_sources WHERE memory_id = ? AND revision = ? ORDER BY session_id, event_seq",
      )
      .all(memoryId, revision)
      .map((row) => ({
        memoryId: String(row.memory_id),
        revision: Number(row.revision),
        sessionId: String(row.session_id),
        runId: String(row.run_id),
        eventId: String(row.event_id),
        eventSeq: Number(row.event_seq),
      }));
  }

  // 获取工作区当前发布的上下文目录指针。
  public findContext(workspaceId: string): { directoryId: string; updatedAt: number } | null {
    const row = this.database
      .prepare("SELECT directory_id, updated_at FROM dreaming_context WHERE workspace_id = ?")
      .get(workspaceId);
    return row === undefined
      ? null
      : { directoryId: String(row.directory_id), updatedAt: Number(row.updated_at) };
  }

  // 读取上下文目录对应的已发布版本号。
  public findContextVersion(workspaceId: string, directoryId: string): number | null {
    const row = this.database
      .prepare(
        `SELECT MAX(version) AS version FROM dreaming_context_versions
        WHERE workspace_id = ? AND directory_id = ?`,
      )
      .get(workspaceId, directoryId);
    return row?.version === null || row?.version === undefined ? null : Number(row.version);
  }

  // 查询未发布上下文目录，供恢复清理使用。
  public hasContextVersion(workspaceId: string, directoryId: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 FROM dreaming_context_versions WHERE workspace_id = ? AND directory_id = ?",
        )
        .get(workspaceId, directoryId) !== undefined
    );
  }

  // 在调用方事务内写入新的上下文版本并移动指针。
  private saveContext(input: { workspaceId: string; directoryId: string; now: number }): void {
    this.database
      .prepare(`INSERT INTO dreaming_context_versions
      (workspace_id, version, directory_id, created_at)
      VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM dreaming_context_versions WHERE workspace_id = ?), ?, ?)`)
      .run(input.workspaceId, input.workspaceId, input.directoryId, input.now);
    this.database
      .prepare(`INSERT INTO dreaming_context (workspace_id, directory_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET directory_id = excluded.directory_id, updated_at = excluded.updated_at`)
      .run(input.workspaceId, input.directoryId, input.now);
  }

  // 主 Agent 记录新上下文版本；指针已变化时由调用方重试。
  public publishContext(input: {
    workspaceId: string;
    directoryId: string;
    expectedDirectoryId: string | null;
    now: number;
  }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (
        (this.findContext(input.workspaceId)?.directoryId ?? null) !== input.expectedDirectoryId
      ) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.saveContext(input);
      this.database.exec("COMMIT");
      return true;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 获取工作区当前发布的 Wiki 目录。
  public findWiki(workspaceId: string): DreamingWikiRecord | null {
    const row = this.database
      .prepare("SELECT * FROM dreaming_wiki WHERE workspace_id = ?")
      .get(workspaceId);
    return row === undefined
      ? null
      : {
          workspaceId: String(row.workspace_id),
          directoryId: String(row.directory_id),
          updatedAt: Number(row.updated_at),
        };
  }

  // 保存工作区当前发布的 Wiki 指针。
  public saveWiki(wiki: DreamingWikiRecord): void {
    // 已发布目录作为稳定版本保留，未发布目录可在恢复时清理。
    this.database
      .prepare(`INSERT OR IGNORE INTO dreaming_wiki_versions
      (workspace_id, version, directory_id, created_at)
      VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM dreaming_wiki_versions WHERE workspace_id = ?), ?, ?)`)
      .run(wiki.workspaceId, wiki.workspaceId, wiki.directoryId, wiki.updatedAt);
    this.database
      .prepare(`INSERT INTO dreaming_wiki (workspace_id, directory_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET directory_id = excluded.directory_id, updated_at = excluded.updated_at`)
      .run(wiki.workspaceId, wiki.directoryId, wiki.updatedAt);
  }

  // 查询已发布的 Wiki 版本，供恢复清理和 Run 按版本读取。
  public hasWikiVersion(workspaceId: string, directoryId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM dreaming_wiki_versions WHERE workspace_id = ? AND directory_id = ?")
        .get(workspaceId, directoryId) !== undefined
    );
  }

  // 保存 Run 处理状态与候选。
  public saveRun(run: DreamingRunRecord): void {
    this.database
      .prepare(`INSERT INTO dreaming_runs
      (run_id, workspace_id, session_id, start_generation, status, candidates_json, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, candidates_json = excluded.candidates_json,
        finished_at = excluded.finished_at, updated_at = excluded.updated_at`)
      .run(
        run.runId,
        run.workspaceId,
        run.sessionId,
        run.startGeneration,
        run.status,
        run.candidatesJson,
        run.startedAt,
        run.finishedAt,
        run.updatedAt,
      );
  }

  // 读取 Run 的处理状态与候选。
  public findRun(runId: string): DreamingRunRecord | null {
    const row = this.database.prepare("SELECT * FROM dreaming_runs WHERE run_id = ?").get(runId);
    if (row === undefined) return null;
    return {
      runId: String(row.run_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      startGeneration: Number(row.start_generation),
      status: String(row.status) as DreamingRunStatus,
      candidatesJson: row.candidates_json === null ? null : String(row.candidates_json),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // 在调用方事务内写入工作区记忆、版本、来源和索引。
  private applyWorkspaceMemoryChange(input: {
    workspaceId: string;
    change: DreamingMemoryChange;
    defaultSessionId: string;
    now: number;
  }): { memoryId: string; revision: number; created: boolean } {
    const { change, workspaceId } = input;
    const content = change.content.trim().replaceAll(/\s+/g, " ");
    if (!content || content.length > 500) throw new Error("Invalid memory content");
    const normalized = content.toLocaleLowerCase();
    const expectedRevision = change.expectedRevision;
    const created = expectedRevision === null;
    let baseRevision: number | null = null;
    let revision = 1;
    if (created) {
      this.database
        .prepare(`INSERT INTO memories
        (id, content, normalized_content, profile_facet, scope, workspace_id, status, source_type, source_session_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 'workspace', ?, 'saved', 'session', ?, 1, ?, ?)`)
        .run(
          change.memoryId,
          content,
          normalized,
          workspaceId,
          change.sources[0]?.sessionId ?? input.defaultSessionId,
          input.now,
          input.now,
        );
    } else {
      const current = this.database
        .prepare("SELECT * FROM memories WHERE id = ? AND workspace_id = ? AND scope = 'workspace'")
        .get(change.memoryId, workspaceId);
      if (!current) throw new Error("Dreaming memory not found");
      // 主 Agent 可能在整理期间写入新版本；以最新版本为基准重新判断是否需要更新。
      baseRevision = Number(current.revision);
      this.database
        .prepare(`INSERT OR IGNORE INTO memory_revisions
        (memory_id, revision, content, applicability, evidence_status, created_at) VALUES (?, ?, ?, NULL, 'unverified', ?)`)
        .run(change.memoryId, baseRevision, String(current.content), Number(current.updated_at));
      this.database
        .prepare(`INSERT OR IGNORE INTO memory_revision_embeddings
        (memory_id, revision, model_id, dimensions, embedding)
        SELECT memory_id, memory_revision, model_id, dimensions, embedding FROM memory_embeddings
        WHERE memory_id = ? AND memory_revision = ?`)
        .run(change.memoryId, baseRevision);
      // 来源集合发生变化时也发布新版本，旧版本的来源保持不变。
      const previous = this.findRevision(change.memoryId, baseRevision);
      revision = resolveDreamingRevision(
        change,
        { content: String(current.content), revision: baseRevision },
        previous,
        this.listSources(change.memoryId, baseRevision),
      );
      if (revision === baseRevision) return { created: false, memoryId: change.memoryId, revision };
      this.database
        .prepare(
          `UPDATE memories SET content = ?, normalized_content = ?, revision = ?, updated_at = ? WHERE id = ?`,
        )
        .run(content, normalized, revision, input.now, change.memoryId);
      this.database.prepare("DELETE FROM memory_search WHERE memory_id = ?").run(change.memoryId);
      this.database
        .prepare("DELETE FROM memory_embeddings WHERE memory_id = ?")
        .run(change.memoryId);
    }
    this.database
      .prepare("INSERT INTO memory_search (memory_id, content) VALUES (?, ?)")
      .run(change.memoryId, content);
    if (change.embedding) {
      const embedding = change.embedding;
      this.database
        .prepare(`INSERT INTO memory_embeddings
        (memory_id, model_id, dimensions, embedding, memory_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          change.memoryId,
          embedding.modelId,
          embedding.dimensions,
          new Uint8Array(Float32Array.from(embedding.values).buffer),
          revision,
          input.now,
        );
    }
    this.createRevision({
      memoryId: change.memoryId,
      revision,
      content,
      applicability: change.applicability,
      evidenceStatus: change.evidenceStatus,
      createdAt: input.now,
    });
    if (change.embedding) {
      this.database
        .prepare(`INSERT INTO memory_revision_embeddings
        (memory_id, revision, model_id, dimensions, embedding) VALUES (?, ?, ?, ?, ?)`)
        .run(
          change.memoryId,
          revision,
          change.embedding.modelId,
          change.embedding.dimensions,
          new Uint8Array(Float32Array.from(change.embedding.values).buffer),
        );
    }
    if (baseRevision !== null) {
      // 新版本保留此前可追溯的来源。
      this.database
        .prepare(`INSERT INTO memory_revision_sources (memory_id, revision, session_id, run_id, event_id, event_seq)
        SELECT memory_id, ?, session_id, run_id, event_id, event_seq FROM memory_revision_sources WHERE memory_id = ? AND revision = ?`)
        .run(revision, change.memoryId, baseRevision);
    }
    for (const source of change.sources)
      this.database
        .prepare(`INSERT OR IGNORE INTO memory_revision_sources
        (memory_id, revision, session_id, run_id, event_id, event_seq) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          change.memoryId,
          revision,
          source.sessionId,
          source.runId,
          source.eventId,
          source.eventSeq,
        );
    return { created, memoryId: change.memoryId, revision };
  }

  // 主 Agent 记录一条工作区记忆，与 Dreaming 共用版本和索引结构。
  public recordWorkspaceMemory(input: {
    workspaceId: string;
    sessionId: string;
    change: DreamingMemoryChange;
    now: number;
  }): { memoryId: string; revision: number; created: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.applyWorkspaceMemoryChange({
        workspaceId: input.workspaceId,
        change: input.change,
        defaultSessionId: input.sessionId,
        now: input.now,
      });
      this.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 将草案的记忆、来源、索引、上下文、Wiki 指针和 Run 状态作为一个事务发布。
  public publish(input: {
    workspaceId: string;
    directoryId: string;
    contextDirectoryId: string;
    runId: string;
    runIds?: readonly string[];
    changes: DreamingMemoryChange[];
    references?: { memoryId: string; revision: number; isCurrent: boolean }[];
    expectedDirectoryId: string | null;
    expectedContextDirectoryId: string | null;
    now: number;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.findRun(input.runId);
      if (!run || run.workspaceId !== input.workspaceId || run.status !== RunStatus.CONSOLIDATING) {
        throw new Error("Dreaming run is not ready to publish");
      }
      const runIds = input.runIds ?? [input.runId];
      if (
        runIds.length < 1 ||
        !runIds.includes(input.runId) ||
        new Set(runIds).size !== runIds.length
      )
        throw new Error("Invalid Dreaming batch");
      for (const id of runIds) {
        const item = this.findRun(id);
        if (
          !item ||
          item.workspaceId !== input.workspaceId ||
          item.status !== RunStatus.CONSOLIDATING
        )
          throw new Error("Dreaming batch is not ready to publish");
      }
      if ((this.findWiki(input.workspaceId)?.directoryId ?? null) !== input.expectedDirectoryId) {
        throw new Error("Dreaming Wiki changed");
      }
      if (
        (this.findContext(input.workspaceId)?.directoryId ?? null) !==
        input.expectedContextDirectoryId
      ) {
        throw new Error("Dreaming context changed");
      }
      const seen = new Set<string>();
      for (const reference of input.references ?? []) {
        const row = this.database
          .prepare(
            "SELECT revision FROM memories WHERE id = ? AND workspace_id = ? AND scope = 'workspace'",
          )
          .get(reference.memoryId, input.workspaceId);
        if (!row) throw new Error("Dreaming referenced memory missing");
        // 整理期间主 Agent 可能推进版本；只要引用版本仍存在即可发布。
        if (
          row.revision !== reference.revision &&
          !this.findRevision(reference.memoryId, reference.revision)
        ) {
          throw new Error("Dreaming referenced revision not found");
        }
      }
      for (const change of input.changes) {
        if (seen.has(change.memoryId)) throw new Error("Duplicate memory change");
        seen.add(change.memoryId);
        this.applyWorkspaceMemoryChange({
          workspaceId: input.workspaceId,
          change,
          defaultSessionId: run.sessionId,
          now: input.now,
        });
      }
      this.saveWiki({
        workspaceId: input.workspaceId,
        directoryId: input.directoryId,
        updatedAt: input.now,
      });
      this.saveContext({
        workspaceId: input.workspaceId,
        directoryId: input.contextDirectoryId,
        now: input.now,
      });
      for (const id of runIds) {
        this.database
          .prepare(
            "UPDATE dreaming_runs SET status = ?, candidates_json = NULL, updated_at = ? WHERE run_id = ?",
          )
          .run(RunStatus.COMPLETED, input.now, id);
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
