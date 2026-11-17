import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DREAMING_WIKI_NAME_PATTERN, type DreamingReader } from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import { textData } from "../utils/dreaming-analysis.js";
import { ID_PATTERN } from "../utils/dreaming-wiki.js";

// 从当前发布目录及其引用中读取工作区记忆。
export class DreamingReaderService implements DreamingReader {
  public constructor(
    private readonly root: string,
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: SqliteMemoryRepository,
    private readonly sessions: SessionRepository,
    private readonly events: SessionEventStore,
  ) {}

  // 只读取数据库指向的当前 Wiki 文件。
  public async readWiki(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!ID_PATTERN.test(workspaceId) || !DREAMING_WIKI_NAME_PATTERN.test(name))
      throw new Error("Invalid Wiki reference");
    const wiki = this.dreaming.findWiki(workspaceId);
    if (!wiki) return null;
    if (!ID_PATTERN.test(wiki.directoryId)) throw new Error("Invalid Wiki directory");
    try {
      return await readFile(join(this.root, "dreaming", workspaceId, wiki.directoryId, name), {
        encoding: "utf8",
        ...(signal ? { signal } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const current = this.dreaming.findWiki(workspaceId);
        if (current && current.directoryId !== wiki.directoryId)
          return this.readWiki(workspaceId, name, signal);
        return null;
      }
      throw error;
    }
  }

  // 校验工作区归属并返回指定版本及其来源。
  public readRevision(workspaceId: string, memoryId: string, revision: number): unknown {
    const memory = this.memories.find(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) throw new Error("Memory not found");
    const version = this.dreaming.findRevision(memoryId, revision);
    if (!version && memory.revision !== revision) throw new Error("Memory revision not found");
    return {
      memory,
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
  ): Promise<unknown> {
    this.readRevision(workspaceId, memoryId, revision);
    const source = this.dreaming
      .listSources(memoryId, revision)
      .find((item) => item.sessionId === sessionId && item.eventId === eventId);
    if (!source || this.sessions.find(sessionId)?.workspaceId !== workspaceId)
      throw new Error("Memory source not found");
    const event = (await this.events.load(sessionId, signal)).events.find(
      (item) => item.id === eventId && item.seq === source.eventSeq && item.runId === source.runId,
    );
    if (!event) throw new Error("Memory source event not found");
    return { ...event, data: textData(event.data) };
  }
}
