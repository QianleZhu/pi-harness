import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DREAMING_WIKI_NAME_PATTERN,
  type DreamingReader,
  MemoryEvidenceStatus,
  MemoryScope,
  type RunMemorySnapshot,
} from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import { textData } from "../utils/dreaming-analysis.js";
import { ID_PATTERN } from "../utils/dreaming-wiki.js";

// 从固定发布版本及其引用中读取工作区和全局记忆。
export class DreamingReaderService implements DreamingReader {
  public constructor(
    private readonly root: string,
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: SqliteMemoryRepository,
    private readonly sessions: SessionRepository,
    private readonly events: SessionEventStore,
  ) {}

  // 固定 Run 启动时的 Wiki 与可见记忆版本。
  public captureSnapshot(workspaceId: string): RunMemorySnapshot {
    return this.dreaming.captureSnapshot(workspaceId);
  }

  // 直接读取固定版本中完整的全局记忆及适用条件。
  public readGlobalContext(snapshot?: RunMemorySnapshot): string | null {
    const memories = snapshot
      ? (snapshot.globalMemories ?? [])
      : this.dreaming.getGlobalVersion().memories;
    if (!memories.length) return null;
    return memories
      .map((memory) => {
        const revision = this.dreaming.findRevision(memory.id, memory.revision);
        const applicability = revision?.applicability;
        const uncertain =
          revision &&
          revision.evidenceStatus !== MemoryEvidenceStatus.USER_STATED &&
          revision.evidenceStatus !== MemoryEvidenceStatus.PRACTICED
            ? `（证据状态：${revision.evidenceStatus}）`
            : "";
        return `- ${memory.content}${applicability ? `（适用条件：${applicability}）` : ""}${uncertain} [memory:${memory.id}@${memory.revision}]`;
      })
      .join("\n");
  }

  // 读取数据库指向的工作区 Wiki 文件。
  public async readWiki(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot,
  ): Promise<string | null> {
    if (!ID_PATTERN.test(workspaceId) || !DREAMING_WIKI_NAME_PATTERN.test(name))
      throw new Error("Invalid Wiki reference");
    const directoryId = snapshot
      ? snapshot.wikiDirectoryId
      : this.dreaming.findWiki(workspaceId)?.directoryId;
    if (!directoryId) return null;
    if (!ID_PATTERN.test(directoryId)) throw new Error("Invalid Wiki directory");
    try {
      return await readFile(join(this.root, "dreaming", workspaceId, directoryId, name), {
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const current = this.dreaming.findWiki(workspaceId);
        if (!snapshot && current && current.directoryId !== directoryId)
          return this.readWiki(workspaceId, name, signal);
        return null;
      }
      throw error;
    }
  }

  // 校验可见范围并返回指定版本及其来源。
  public readRevision(
    workspaceId: string,
    memoryId: string,
    revision: number,
    snapshot?: RunMemorySnapshot,
  ): unknown {
    if (snapshot && (snapshot.versions.get(memoryId) ?? 0) < revision)
      throw new Error("Memory version not in snapshot");
    const memory =
      snapshot?.globalMemories?.find((item) => item.id === memoryId) ??
      snapshot?.workspaceMemories?.find((item) => item.id === memoryId) ??
      this.memories.find(memoryId);
    if (!memory || (memory.scope !== MemoryScope.USER && memory.workspaceId !== workspaceId))
      throw new Error("Memory not found");
    const version = this.dreaming.findRevision(memoryId, revision);
    if (!version && memory.revision !== revision) throw new Error("Memory revision not found");
    return {
      memory: version ? { ...memory, content: version.content, revision } : memory,
      revision: version ?? { memoryId, revision, content: memory.content },
      sources: this.dreaming.listSources(memoryId, revision),
    };
  }

  // 通过记忆版本关联定位来源事件，避免读取无关会话。
  public async readSource(
    workspaceId: string,
    memoryId: string,
    revision: number,
    sessionId: string,
    eventId: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot,
  ): Promise<unknown> {
    this.readRevision(workspaceId, memoryId, revision, snapshot);
    const source = this.dreaming
      .listSources(memoryId, revision)
      .find((item) => item.sessionId === sessionId && item.eventId === eventId);
    const memory =
      snapshot?.globalMemories?.find((item) => item.id === memoryId) ??
      snapshot?.workspaceMemories?.find((item) => item.id === memoryId) ??
      this.memories.find(memoryId);
    if (
      !source ||
      !memory ||
      (memory.scope !== MemoryScope.USER &&
        this.sessions.find(sessionId)?.workspaceId !== workspaceId)
    )
      throw new Error("Memory source not found");
    const event = (await this.events.load(sessionId, signal)).events.find(
      (item) => item.id === eventId && item.seq === source.eventSeq && item.runId === source.runId,
    );
    if (!event) throw new Error("Memory source event not found");
    return { ...event, data: textData(event.data) };
  }
}
