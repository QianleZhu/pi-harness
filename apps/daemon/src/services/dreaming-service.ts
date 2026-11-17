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
import { readStoredCandidates, textData } from "../utils/dreaming-analysis.js";
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

  // 提取单个 Run 的候选，并在进入整理队列前持久化。
  public async analyzeRun(input: {
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
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    signal.throwIfAborted();
    const settings = this.memories.getSettings();
    if (!settings.useMemories || !settings.generateMemories)
      throw new Error("Dreaming learning is disabled");
    if (!this.dreaming.claimRun(input.runId, Date.now()))
      throw new Error("Dreaming run already claimed");
    try {
      const candidates = await this.analysis.analyze({ ...input, signal }, resolved);
      this.dreaming.saveRun({
        ...run,
        status: candidates.length
          ? DreamingRunStatus.PENDING_CONSOLIDATION
          : DreamingRunStatus.NO_CANDIDATES,
        candidatesJson: candidates.length ? JSON.stringify(candidates) : null,
        updatedAt: Date.now(),
      });
    } catch (error: unknown) {
      this.dreaming.saveRun({
        ...run,
        status: DreamingRunStatus.FAILED,
        candidatesJson: null,
        updatedAt: Date.now(),
      });
      throw error;
    }
  }

  // 同一工作区的一到两个 Run 共用整理草案并原子发布。
  public async consolidateRuns(input: {
    workspaceId: string;
    runIds: readonly string[];
    providerId: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const runIds = input.runIds;
    if (
      runIds.length < 1 ||
      runIds.length > 2 ||
      new Set(runIds).size !== runIds.length ||
      !ID_PATTERN.test(input.workspaceId)
    )
      throw new Error("Invalid Dreaming batch");
    const runs = runIds.map((id) => this.dreaming.findRun(id));
    if (
      runs.some(
        (run) =>
          !run ||
          run.workspaceId !== input.workspaceId ||
          run.status !== DreamingRunStatus.PENDING_CONSOLIDATION ||
          run.candidatesJson === null,
      )
    )
      throw new Error("Dreaming batch is not pending");
    const first = runs[0];
    if (!first) throw new Error("Dreaming batch is empty");
    const resolved = await this.providers.resolveRunModel(input.providerId, input.modelId);
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)])
      : AbortSignal.timeout(300_000);
    signal.throwIfAborted();
    if (!this.dreaming.claimConsolidation(runIds, Date.now()))
      throw new Error("Dreaming batch already claimed");
    let directory: string | null = null;
    let published = false;
    const toolInput = {
      workspaceId: input.workspaceId,
      sessionId: first.sessionId,
      runId: first.runId,
    };
    try {
      const groups = runs.map((run) => {
        if (!run?.candidatesJson) throw new Error("Dreaming candidates missing");
        return { run, candidates: readStoredCandidates(run.candidatesJson) };
      });
      const candidates = groups.flatMap((group) => group.candidates);
      const candidateRuns = groups.flatMap((group) =>
        group.candidates.map(() => ({ sessionId: group.run.sessionId, runId: group.run.runId })),
      );
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
        input: toolInput,
        signal,
        candidates,
        candidateRuns,
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
        runId: first.runId,
        runIds,
        changes,
        references,
        expectedDirectoryId: currentWiki?.directoryId ?? null,
        now: Date.now(),
      });
      published = true;
    } catch (error: unknown) {
      if (!published) {
        this.dreaming.failConsolidation(runIds, Date.now());
        if (directory) await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  // 为内部调用保留单 Run 的完整整理入口。
  public async processRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    providerId: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.analyzeRun(input);
    if (this.dreaming.findRun(input.runId)?.status === DreamingRunStatus.PENDING_CONSOLIDATION) {
      await this.consolidateRuns({
        workspaceId: input.workspaceId,
        runIds: [input.runId],
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
  }
}
