import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgent } from "@pi-harness/agent-runtime";
import {
  createDreamingTools,
  DREAMING_CONSOLIDATION_PROMPT,
  type DreamingMemoryChange,
  DreamingRunStatus,
  type MemoryEmbedder,
  type MemoryService,
} from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import { textData } from "../utils/dreaming-analysis.js";
import { ID_PATTERN, readWiki, validateWiki } from "../utils/dreaming-wiki.js";
import { DreamingAnalysisService } from "./dreaming-analysis-service.js";
import type { ProviderService } from "./provider-service.js";

// 串联单 Run 分析、整理草案和数据库发布。
export class DreamingService {
  private readonly analysis: DreamingAnalysisService;
  public constructor(
    private readonly root: string,
    private readonly sessions: SessionRepository,
    private readonly events: SessionEventStore,
    private readonly providers: ProviderService,
    private readonly memories: MemoryService,
    private readonly memoryStore: SqliteMemoryRepository,
    private readonly dreaming: SqliteDreamingRepository,
    private readonly embedder: MemoryEmbedder,
  ) {
    this.analysis = new DreamingAnalysisService(sessions, events, providers);
  }

  // 处理已登记的待分析 Run；模型不可用时保持原状态。
  public async processRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    providerId: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const run = this.dreaming.findRun(input.runId);
    if (
      !run ||
      run.workspaceId !== input.workspaceId ||
      run.sessionId !== input.sessionId ||
      run.status !== DreamingRunStatus.PENDING
    )
      throw new Error("Dreaming run is not pending");
    if (!ID_PATTERN.test(input.workspaceId)) throw new Error("Invalid workspace ID");
    const resolved = await this.providers.resolveRunModel(input.providerId, input.modelId);
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)])
      : AbortSignal.timeout(300_000);
    signal.throwIfAborted();
    let directory: string | null = null;
    let published = false;
    if (!this.dreaming.claimRun(input.runId, Date.now()))
      throw new Error("Dreaming run already claimed");
    try {
      const candidates = await this.analysis.analyze({ ...input, signal }, resolved);
      if (candidates.length === 0) {
        this.dreaming.saveRun({
          ...run,
          status: DreamingRunStatus.NO_CANDIDATES,
          candidatesJson: null,
          updatedAt: Date.now(),
        });
        return;
      }
      this.dreaming.saveRun({
        ...run,
        status: DreamingRunStatus.PENDING_CONSOLIDATION,
        candidatesJson: JSON.stringify(candidates),
        updatedAt: Date.now(),
      });
      const currentWiki = this.dreaming.findWiki(input.workspaceId);
      if (currentWiki && !ID_PATTERN.test(currentWiki.directoryId))
        throw new Error("Invalid Wiki directory");
      const workspaceDir = join(this.root, "dreaming", input.workspaceId);
      const files = await readWiki(
        currentWiki ? join(workspaceDir, currentWiki.directoryId) : null,
      );
      const changes: DreamingMemoryChange[] = [];
      let abortAgent = () => {};
      const tools = createDreamingTools({
        input,
        signal,
        candidates,
        files,
        changes,
        sessions: this.sessions,
        events: this.events,
        memories: this.memories,
        memoryStore: this.memoryStore,
        dreaming: this.dreaming,
        projectEventData: textData,
        onLimit: () => abortAgent(),
      });
      this.dreaming.saveRun({
        ...run,
        status: DreamingRunStatus.CONSOLIDATING,
        candidatesJson: JSON.stringify(candidates),
        updatedAt: Date.now(),
      });
      const agent = createAgent({
        messages: [],
        model: resolved.model,
        sessionId: randomUUID(),
        systemPrompt: DREAMING_CONSOLIDATION_PROMPT,
        streamFn: resolved.streamFn,
        tools,
      });
      const abort = () => agent.abort();
      abortAgent = abort;
      signal.addEventListener("abort", abort, { once: true });
      try {
        await agent.prompt(JSON.stringify({ candidates }));
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
      }
      const last = agent.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "stop")
        throw new Error("Dreaming consolidation failed");
      const references = validateWiki(
        files,
        changes,
        this.memoryStore,
        this.dreaming,
        input.workspaceId,
      );
      // 提前准备向量，失败时保留关键词召回并由现有索引机制重建。
      for (const change of changes) {
        try {
          const [vector] = await this.embedder.embed(
            "document",
            [change.content.trim().replaceAll(/\s+/g, " ")],
            signal,
          );
          if (!vector?.length || vector.some((value) => !Number.isFinite(value)))
            throw new Error("Invalid memory embedding");
          const magnitude = Math.hypot(...vector);
          if (!magnitude) throw new Error("Invalid memory embedding");
          change.embedding = {
            modelId: this.embedder.modelId,
            dimensions: vector.length,
            values: vector.map((value) => value / magnitude),
          };
        } catch (error: unknown) {
          if (signal.aborted) throw error;
          change.embedding = null;
        }
      }
      const directoryId = randomUUID();
      directory = join(workspaceDir, directoryId);
      await mkdir(directory, { recursive: true });
      for (const [name, content] of files)
        await writeFile(join(directory, name), content, { encoding: "utf8", signal });
      signal.throwIfAborted();
      this.dreaming.publish({
        workspaceId: input.workspaceId,
        directoryId,
        runId: input.runId,
        changes,
        references,
        expectedDirectoryId: currentWiki?.directoryId ?? null,
        now: Date.now(),
      });
      published = true;
      if (currentWiki)
        await rm(join(workspaceDir, currentWiki.directoryId), { recursive: true, force: true });
    } catch (error: unknown) {
      if (!published) {
        this.dreaming.saveRun({
          ...run,
          status: DreamingRunStatus.FAILED,
          candidatesJson: null,
          updatedAt: Date.now(),
        });
        if (directory) await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }
}
