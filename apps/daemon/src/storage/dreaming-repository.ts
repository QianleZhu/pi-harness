import type { DatabaseSync } from "node:sqlite";
import {
  type DreamingRunStatus,
  MemoryEvidenceStatus,
  type MemoryRevision,
  type MemoryRevisionSource,
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
}
