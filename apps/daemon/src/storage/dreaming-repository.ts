import type { DatabaseSync } from "node:sqlite";
import {
  type DreamingMemoryChange,
  type DreamingRunStatus,
  MemoryEvidenceStatus,
  type MemoryRevision,
  type MemoryRevisionSource,
  DreamingRunStatus as RunStatus,
} from "@pi-harness/memory";

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
    this.database
      .prepare(`INSERT INTO dreaming_wiki (workspace_id, directory_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET directory_id = excluded.directory_id, updated_at = excluded.updated_at`)
      .run(wiki.workspaceId, wiki.directoryId, wiki.updatedAt);
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

  // 原子领取待分析的 Run，防止重复启动。
  public claimRun(runId: string, updatedAt: number): boolean {
    return (
      this.database
        .prepare(
          "UPDATE dreaming_runs SET status = ?, updated_at = ? WHERE run_id = ? AND status = ?",
        )
        .run(RunStatus.ANALYZING, updatedAt, runId, RunStatus.PENDING).changes === 1
    );
  }

  // 将草案的记忆、来源、索引、Wiki 指针和 Run 状态作为一个事务发布。
  public publish(input: {
    workspaceId: string;
    directoryId: string;
    runId: string;
    changes: DreamingMemoryChange[];
    references?: { memoryId: string; revision: number; isCurrent: boolean }[];
    expectedDirectoryId: string | null;
    now: number;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.findRun(input.runId);
      if (!run || run.workspaceId !== input.workspaceId || run.status !== RunStatus.CONSOLIDATING) {
        throw new Error("Dreaming run is not ready to publish");
      }
      if ((this.findWiki(input.workspaceId)?.directoryId ?? null) !== input.expectedDirectoryId) {
        throw new Error("Dreaming Wiki changed");
      }
      const seen = new Set<string>();
      for (const reference of input.references ?? []) {
        const row = this.database
          .prepare(
            "SELECT revision FROM memories WHERE id = ? AND workspace_id = ? AND scope = 'workspace'",
          )
          .get(reference.memoryId, input.workspaceId);
        if (!row || (reference.isCurrent && row.revision !== reference.revision))
          throw new Error("Dreaming referenced memory changed");
        if (
          !reference.isCurrent &&
          row.revision !== reference.revision &&
          !this.findRevision(reference.memoryId, reference.revision)
        ) {
          throw new Error("Dreaming referenced revision not found");
        }
      }
      for (const change of input.changes) {
        if (seen.has(change.memoryId)) throw new Error("Duplicate memory change");
        seen.add(change.memoryId);
        const content = change.content.trim().replaceAll(/\s+/g, " ");
        if (!content || content.length > 500) throw new Error("Invalid memory content");
        const normalized = content.toLocaleLowerCase();
        let revision = 1;
        if (change.expectedRevision === null) {
          this.database
            .prepare(`INSERT INTO memories
            (id, content, normalized_content, profile_facet, scope, workspace_id, status, source_type, source_session_id, revision, created_at, updated_at)
            VALUES (?, ?, ?, NULL, 'workspace', ?, 'saved', 'session', ?, 1, ?, ?)`)
            .run(
              change.memoryId,
              content,
              normalized,
              input.workspaceId,
              run.sessionId,
              input.now,
              input.now,
            );
        } else {
          const current = this.database
            .prepare(
              "SELECT * FROM memories WHERE id = ? AND workspace_id = ? AND scope = 'workspace'",
            )
            .get(change.memoryId, input.workspaceId);
          if (!current || current.revision !== change.expectedRevision)
            throw new Error("Dreaming memory revision conflict");
          // 若当前版本来自手动修改，先保留该版本，避免覆盖旧内容。
          this.database
            .prepare(`INSERT OR IGNORE INTO memory_revisions
            (memory_id, revision, content, applicability, evidence_status, created_at) VALUES (?, ?, ?, NULL, 'unverified', ?)`)
            .run(
              change.memoryId,
              change.expectedRevision,
              String(current.content),
              Number(current.updated_at),
            );
          // 内容一致时复用当前版本并补充来源。
          const previous = this.findRevision(change.memoryId, change.expectedRevision);
          if (
            current.content === content &&
            previous?.applicability === change.applicability &&
            previous.evidenceStatus === change.evidenceStatus
          ) {
            for (const source of change.sources) {
              this.database
                .prepare(`INSERT OR IGNORE INTO memory_revision_sources
                (memory_id, revision, session_id, run_id, event_id, event_seq) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(
                  change.memoryId,
                  change.expectedRevision,
                  source.sessionId,
                  source.runId,
                  source.eventId,
                  source.eventSeq,
                );
            }
            continue;
          }
          revision = change.expectedRevision + 1;
          this.database
            .prepare(
              `UPDATE memories SET content = ?, normalized_content = ?, revision = ?, updated_at = ? WHERE id = ?`,
            )
            .run(content, normalized, revision, input.now, change.memoryId);
          this.database
            .prepare("DELETE FROM memory_search WHERE memory_id = ?")
            .run(change.memoryId);
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
        if (change.expectedRevision !== null) {
          // 新版本保留此前可追溯的来源。
          this.database
            .prepare(`INSERT INTO memory_revision_sources (memory_id, revision, session_id, run_id, event_id, event_seq)
            SELECT memory_id, ?, session_id, run_id, event_id, event_seq FROM memory_revision_sources WHERE memory_id = ? AND revision = ?`)
            .run(revision, change.memoryId, change.expectedRevision);
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
      }
      this.saveWiki({
        workspaceId: input.workspaceId,
        directoryId: input.directoryId,
        updatedAt: input.now,
      });
      this.saveRun({
        ...run,
        status: RunStatus.COMPLETED,
        candidatesJson: null,
        updatedAt: input.now,
      });
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
