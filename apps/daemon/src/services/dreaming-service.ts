import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContextCompactedData,
  createAgent,
  type HarnessEvent,
  projectContext,
} from "@pi-harness/agent-runtime";
import {
  createDreamingTools,
  DREAMING_AGENT_PROMPT,
  DREAMING_BOOTSTRAP_PROMPT,
  type DreamingMemoryChange,
  DreamingRunStatus,
  type GlobalDreamingCandidate,
  type MemoryEmbedder,
  type MemoryService,
  resolveDreamingRevision,
} from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import { selectRunEvents, textData } from "../utils/dreaming-events.js";
import {
  contextDirectory,
  DEFAULT_MEMORY_CONTEXT,
  EMPTY_WIKI_INDEX,
  ID_PATTERN,
  readContextFile,
  readWiki,
  stripRecordedMemorySection,
  validateContext,
  validateWiki,
} from "../utils/dreaming-wiki.js";
import type { GlobalDreamingService } from "./global-dreaming-service.js";
import type { ProviderService } from "./provider-service.js";

const DREAMING_TIMEOUT_MS = 20 * 60_000;

// 一个工作区只运行一个带工具的 Agent，依次审计该工作区的所有待处理 Run。
export class DreamingService {
  public constructor(
    private readonly root: string,
    private readonly sessions: SessionRepository,
    private readonly events: SessionEventStore,
    private readonly providers: ProviderService,
    private readonly memories: MemoryService,
    private readonly memoryStore: SqliteMemoryRepository,
    private readonly dreaming: SqliteDreamingRepository,
    private readonly embedder: MemoryEmbedder,
    private readonly globalService: GlobalDreamingService,
  ) {}

  // 同一工作区的全部待处理 Run 由一个 Agent 依次审计，并原子发布结果。
  public async processRuns(input: {
    workspaceId: string;
    runIds: readonly string[];
    providerId: string;
    modelId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const runIds = input.runIds;
    if (
      runIds.length < 1 ||
      new Set(runIds).size !== runIds.length ||
      !ID_PATTERN.test(input.workspaceId)
    )
      throw new Error("Invalid Dreaming batch");
    const runs = runIds.map((id) => this.dreaming.findRun(id));
    if (
      runs.some(
        (run) =>
          !run || run.workspaceId !== input.workspaceId || run.status !== DreamingRunStatus.PENDING,
      )
    )
      throw new Error("Dreaming batch is not pending");
    const batchRuns = runs.filter((run): run is NonNullable<typeof run> => run !== null);
    if (batchRuns.length !== runIds.length) throw new Error("Dreaming run missing");
    const first = batchRuns[0];
    if (!first) throw new Error("Dreaming batch is empty");
    const resolved = await this.providers.resolveRunModel(input.providerId, input.modelId);
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(DREAMING_TIMEOUT_MS)])
      : AbortSignal.timeout(DREAMING_TIMEOUT_MS);
    signal.throwIfAborted();
    const settings = this.memories.getSettings();
    if (!settings.generateMemories) throw new Error("Dreaming learning is disabled");
    if (!this.dreaming.claimPendingRuns(runIds, input.workspaceId, Date.now()))
      throw new Error("Dreaming batch already claimed");

    const runEvents = new Map<string, readonly HarnessEvent[]>();
    try {
      for (const run of batchRuns) {
        const snapshot = await this.events.load(run.sessionId, signal);
        runEvents.set(run.runId, selectRunEvents(snapshot.events, run.runId));
      }
    } catch (error: unknown) {
      this.dreaming.failConsolidation(runIds, Date.now());
      throw error;
    }

    let directory: string | null = null;
    let contextDir: string | null = null;
    let published = false;
    try {
      const currentWiki = this.dreaming.findWiki(input.workspaceId);
      if (currentWiki && !ID_PATTERN.test(currentWiki.directoryId))
        throw new Error("Invalid Wiki directory");
      const workspaceDir = join(this.root, "dreaming", input.workspaceId);
      const files = await readWiki(
        currentWiki ? join(workspaceDir, currentWiki.directoryId) : null,
      );
      const originalFiles = new Map(files);
      // 上下文和 Wiki 分开存储；任一结构缺失时由 Agent 根据原始日志搭建。
      let expectedContextDirectoryId =
        this.dreaming.findContext(input.workspaceId)?.directoryId ?? null;
      let contextVersion = expectedContextDirectoryId
        ? this.dreaming.findContextVersion(input.workspaceId, expectedContextDirectoryId)
        : null;
      if (expectedContextDirectoryId && contextVersion === null)
        throw new Error("Dreaming context version not found");
      const currentContext = expectedContextDirectoryId
        ? await readContextFile(
            contextDirectory(this.root, input.workspaceId, expectedContextDirectoryId),
          )
        : null;
      const contextDraft = {
        content: currentContext?.trim() ? currentContext : DEFAULT_MEMORY_CONTEXT,
      };
      const originalContext = contextDraft.content;
      const bootstrap = !files.has("index.md") || expectedContextDirectoryId === null;
      if (!files.has("index.md")) files.set("index.md", EMPTY_WIKI_INDEX);
      const changes: DreamingMemoryChange[] = [];
      const globalCandidates: GlobalDreamingCandidate[] = [];
      const readRuns = new Set<string>();
      let abortAgent = () => {};
      const tools = createDreamingTools({
        input: { workspaceId: input.workspaceId },
        signal,
        runs: runEvents,
        readRuns,
        files,
        context: contextDraft,
        changes,
        globalCandidates,
        sessions: this.sessions,
        events: this.events,
        memories: this.memories,
        memoryStore: this.memoryStore,
        dreaming: this.dreaming,
        projectEventData: textData,
        onLimit: () => abortAgent(),
      });
      const agentSessionId = randomUUID();
      const agent = createAgent({
        messages: [],
        model: resolved.model,
        sessionId: agentSessionId,
        systemPrompt: bootstrap
          ? `${DREAMING_AGENT_PROMPT}\n${DREAMING_BOOTSTRAP_PROMPT}`
          : DREAMING_AGENT_PROMPT,
        streamFn: resolved.streamFn,
        tools,
      });
      // 复用主 Agent 的上下文压缩：工具结果过多时生成 checkpoint，避免 Dreaming 自己撞窗口。
      let checkpoint: ContextCompactedData | null = null;
      agent.transformContext = async (messages, contextSignal) => {
        const projected = await projectContext({
          activeRunStartMessageIndex: 0,
          checkpoint,
          messages,
          model: resolved.model,
          plan: null,
          todos: null,
          sessionId: agentSessionId,
          ...(contextSignal === undefined ? {} : { signal: contextSignal }),
          streamFn: resolved.streamFn,
          systemPrompt: agent.state.systemPrompt,
          tools: agent.state.tools,
        });
        if (projected.error) throw new Error(`DREAMING_CONTEXT_EXCEEDED: ${projected.error}`);
        if (projected.compacted) checkpoint = projected.compacted;
        return projected.messages;
      };
      const abort = () => agent.abort();
      abortAgent = abort;
      signal.addEventListener("abort", abort, { once: true });
      try {
        await agent.prompt(
          JSON.stringify({
            runs: batchRuns.map((run) => ({
              finishedAt: run.finishedAt,
              runId: run.runId,
              sessionId: run.sessionId,
              startedAt: run.startedAt,
            })),
            workspaceId: input.workspaceId,
          }),
        );
        signal.throwIfAborted();
        const last = agent.state.messages.at(-1);
        if (last?.role !== "assistant" || last.stopReason !== "stop")
          throw new Error("Dreaming consolidation failed");
        // 整理期间主 Agent 可能发布新的上下文版本；让 Agent 对比后再发布。
        for (let round = 0; round < 3; round += 1) {
          const latest = this.dreaming.findContext(input.workspaceId)?.directoryId ?? null;
          const latestVersion = latest
            ? this.dreaming.findContextVersion(input.workspaceId, latest)
            : null;
          if (latest === expectedContextDirectoryId && latestVersion === contextVersion) break;
          if (round === 2) throw new Error("Dreaming context changed");
          const latestContent = latest
            ? await readContextFile(contextDirectory(this.root, input.workspaceId, latest))
            : null;
          signal.throwIfAborted();
          await agent.prompt(
            JSON.stringify({
              contextChanged: true,
              contextVersion: latestVersion,
              latestPublishedContext: latestContent?.trim()
                ? latestContent
                : DEFAULT_MEMORY_CONTEXT,
              message:
                "The published context changed after your snapshot. Compare latestPublishedContext with read_context. If it adds durable knowledge not yet covered, draft memory or update the context draft; if it is already covered, keep your draft. Do not re-read unrelated runs.",
            }),
          );
          signal.throwIfAborted();
          const after = agent.state.messages.at(-1);
          if (after?.role !== "assistant" || after.stopReason !== "stop")
            throw new Error("Dreaming consolidation failed");
          expectedContextDirectoryId = latest;
          contextVersion = latestVersion;
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!runIds.every((runId) => readRuns.has(runId)))
        throw new Error("Dreaming agent did not review every run");

      // 临时区块已由 Agent 融入正式记忆，发布版本必须移除它。
      const stripped = stripRecordedMemorySection(contextDraft.content);
      const contextContent = stripped.trim() ? stripped : DEFAULT_MEMORY_CONTEXT;
      validateContext(contextContent, files);
      const hasMemoryChanges = changes.some((change) => {
        if (change.expectedRevision === null) return true;
        const memory = this.memoryStore.find(change.memoryId);
        if (!memory || memory.workspaceId !== input.workspaceId) return true;
        // 以最新版本判断是否需要更新，兼容整理期间的并发写入。
        return (
          resolveDreamingRevision(
            change,
            memory,
            this.dreaming.findRevision(memory.id, memory.revision),
            this.dreaming.listSources(memory.id, memory.revision),
          ) !== memory.revision
        );
      });
      if (
        !hasMemoryChanges &&
        contextContent === originalContext &&
        expectedContextDirectoryId !== null &&
        files.size === originalFiles.size &&
        [...files].every(([name, content]) => originalFiles.get(name) === content)
      ) {
        this.dreaming.completeConsolidation(runIds, Date.now());
        this.globalService.enqueue(input.workspaceId, globalCandidates);
        return;
      }
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
      const contextDirectoryId = randomUUID();
      contextDir = contextDirectory(this.root, input.workspaceId, contextDirectoryId);
      await mkdir(contextDir, { recursive: true });
      await writeFile(join(contextDir, "context.md"), contextContent, {
        encoding: "utf8",
        signal,
      });
      signal.throwIfAborted();
      this.dreaming.publish({
        workspaceId: input.workspaceId,
        directoryId,
        contextDirectoryId,
        runId: first.runId,
        runIds,
        changes,
        references,
        expectedDirectoryId: currentWiki?.directoryId ?? null,
        expectedContextDirectoryId,
        now: Date.now(),
      });
      published = true;
      this.globalService.enqueue(input.workspaceId, globalCandidates);
    } catch (error: unknown) {
      if (!published) {
        this.dreaming.failConsolidation(runIds, Date.now());
        if (directory) await rm(directory, { recursive: true, force: true });
        if (contextDir) await rm(contextDir, { recursive: true, force: true });
      }
      throw error;
    }
  }
}
