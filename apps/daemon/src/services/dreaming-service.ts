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
    const claimedProvisional = this.dreaming.claimPendingRuns(
      runIds,
      input.workspaceId,
      Date.now(),
    );
    if (!claimedProvisional) throw new Error("Dreaming batch already claimed");

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
      // 正式注入上下文仅由 Dreaming 单写者维护；兼容清理旧版本可能遗留的临时区块。
      const expectedContextDirectoryId =
        this.dreaming.findContext(input.workspaceId)?.directoryId ?? null;
      const contextVersion = expectedContextDirectoryId
        ? this.dreaming.findContextVersion(input.workspaceId, expectedContextDirectoryId)
        : null;
      if (expectedContextDirectoryId && contextVersion === null)
        throw new Error("Dreaming context version not found");
      const currentContext = expectedContextDirectoryId
        ? await readContextFile(
            contextDirectory(this.root, input.workspaceId, expectedContextDirectoryId),
          )
        : null;
      const cleanCurrentContext = currentContext
        ? stripRecordedMemorySection(currentContext)
        : null;
      const contextDraft = {
        content: cleanCurrentContext?.trim() ? cleanCurrentContext : DEFAULT_MEMORY_CONTEXT,
      };
      const originalContext = currentContext?.trim() ? currentContext : DEFAULT_MEMORY_CONTEXT;
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
        provisionalMemories: claimedProvisional,
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
            provisionalMemories: claimedProvisional.map((item) => ({
              applicability: item.applicability,
              content: item.content,
              createdAt: item.createdAt,
              evidenceStatus: item.evidenceStatus,
              id: item.id,
              inBatchRuns: runEvents.has(item.runId),
              runId: item.runId,
              sessionId: item.sessionId,
            })),
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
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!runIds.every((runId) => readRuns.has(runId)))
        throw new Error("Dreaming agent did not review every run");

      const claimedProvisionalIds = claimedProvisional.map((item) => item.id);

      const contextContent = contextDraft.content.trim()
        ? contextDraft.content
        : DEFAULT_MEMORY_CONTEXT;
      validateContext(contextContent, files);
      const hasMemoryChanges = changes.some((change) => {
        if (change.expectedRevision === null) return true;
        const memory = this.memoryStore.find(change.memoryId);
        if (!memory || memory.workspaceId !== input.workspaceId) return true;
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
        this.dreaming.completeConsolidation(
          runIds,
          Date.now(),
          input.workspaceId,
          claimedProvisionalIds,
        );
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
        provisionalIds: claimedProvisionalIds,
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
