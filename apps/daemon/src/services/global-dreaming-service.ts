import { randomUUID } from "node:crypto";
import { type ContextCompactedData, createAgent, projectContext } from "@pi-harness/agent-runtime";
import {
  createGlobalDreamingTools,
  diffGlobalMemories,
  GLOBAL_DREAMING_PROMPT,
  type GlobalDreamingCandidate,
  type GlobalDreamingMemoryChange,
  type MemoryEmbedder,
  type MemoryEmbedding,
} from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { ProviderService } from "./provider-service.js";

const MAX_GLOBAL_MERGE_ROUNDS = 3;

// 串行整理跨工作区候选，提交前比较全局版本；若期间用户修改则计算精确 Diff 执行增量合并。
export class GlobalDreamingService {
  private readonly queue: { workspaceId: string; candidate: GlobalDreamingCandidate }[] = [];
  public constructor(
    private readonly dreaming: SqliteDreamingRepository,
    private readonly sessions: SessionRepository,
    private readonly providers: ProviderService,
    private readonly embedder?: MemoryEmbedder,
  ) {}

  // 工作区发布成功后，将候选放入 Worker 内存队列。
  public enqueue(workspaceId: string, candidates: readonly GlobalDreamingCandidate[]): void {
    this.queue.push(...candidates.map((candidate) => ({ workspaceId, candidate })));
  }

  // 判断是否有候选等待全局整理。
  public hasPending(): boolean {
    return this.queue.length > 0;
  }

  // 本批无有效变更时只完成候选，不生成全局版本；期间用户修改全局记忆时与最新快照增量合并。
  public async consolidate(input: {
    providerId: string;
    modelId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const batch = this.queue.splice(0, 20);
    if (!batch.length) return;
    for (const item of batch) {
      for (const source of item.candidate.sources) {
        if (this.sessions.find(source.sessionId)?.workspaceId !== item.workspaceId)
          throw new Error("Global candidate source not found");
      }
    }
    let base = this.dreaming.getGlobalVersion();
    let currentMemories = base.memories;
    const resolved = await this.providers.resolveRunModel(input.providerId, input.modelId);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(600_000)]);
    signal.throwIfAborted();
    const changes: GlobalDreamingMemoryChange[] = [];
    let abortAgent = () => {};
    const agentSessionId = randomUUID();
    const agent = createAgent({
      messages: [],
      model: resolved.model,
      sessionId: agentSessionId,
      streamFn: resolved.streamFn,
      systemPrompt: GLOBAL_DREAMING_PROMPT,
      tools: createGlobalDreamingTools({
        getMemories: () => currentMemories,
        candidates: batch.map((item) => item.candidate),
        changes,
        signal,
        onLimit: () => abortAgent(),
        readRevision: (id, revision) => this.dreaming.findRevision(id, revision),
        readSources: (id, revision) => this.dreaming.listSources(id, revision),
      }),
    });
    // 复用统一上下文压缩，避免大量候选和记忆把全局 Agent 推出模型窗口。
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
      if (projected.error) throw new Error(`GLOBAL_DREAMING_CONTEXT_EXCEEDED: ${projected.error}`);
      if (projected.compacted) checkpoint = projected.compacted;
      return projected.messages;
    };
    const abort = () => agent.abort();
    abortAgent = abort;
    signal.addEventListener("abort", abort, { once: true });
    try {
      await agent.prompt(
        JSON.stringify({
          memoryCount: base.memories.length,
          candidates: batch.map(({ candidate }) => ({
            content: candidate.content,
            applicability: candidate.applicability,
            evidence: candidate.evidence,
          })),
        }),
      );
      signal.throwIfAborted();
      const firstLast = agent.state.messages.at(-1);
      if (firstLast?.role !== "assistant" || firstLast.stopReason !== "stop")
        throw new Error("Global Dreaming failed");

      for (let mergeRound = 0; mergeRound <= MAX_GLOBAL_MERGE_ROUNDS; mergeRound += 1) {
        const latest = this.dreaming.getGlobalVersion();
        if (latest.version === base.version) {
          if (!changes.length) return;
          await this.prepareEmbeddings(changes, signal);
          signal.throwIfAborted();
          if (
            this.dreaming.publishGlobal({
              expectedVersion: base.version,
              changes,
              now: Date.now(),
            })
          ) {
            return;
          }
        }

        // 版本在整理或提交前被用户修改；达到合并轮次上限时放回队列稍后处理。
        if (mergeRound >= MAX_GLOBAL_MERGE_ROUNDS) {
          this.queue.unshift(...batch);
          return;
        }

        const newest = this.dreaming.getGlobalVersion();
        const diff = diffGlobalMemories(base.memories, newest.memories);
        const updatedIds = new Set(diff.updated.map((item) => item.id));
        const deletedIds = new Set(diff.deleted.map((item) => item.id));
        currentMemories = newest.memories;
        base = newest;

        await agent.prompt(
          JSON.stringify({
            versionChanged: true,
            latestVersion: newest.version,
            userChanges: diff,
            currentDrafts: changes.map((change) => ({
              memoryId: change.memoryId,
              expectedRevision: change.expectedRevision,
              content: change.content,
              applicability: change.applicability,
              evidenceStatus: change.evidenceStatus,
              conflict: deletedIds.has(change.memoryId)
                ? "user_deleted"
                : updatedIds.has(change.memoryId)
                  ? "user_updated"
                  : null,
            })),
            message:
              "User modified global memories while you were consolidating. Perform an incremental merge against the latest version. User edits are authoritative: resolve any conflict in favor of the user, drop or revise conflicting/duplicate drafts with drop_global_draft or draft_global_memory, and do not resurrect deleted memories.",
          }),
        );
        signal.throwIfAborted();
        const afterMerge = agent.state.messages.at(-1);
        if (afterMerge?.role !== "assistant" || afterMerge.stopReason !== "stop")
          throw new Error("Global Dreaming merge failed");
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // 提交前提前计算归一化向量；本地模型不可用时退化为关键词召回。
  private async prepareEmbeddings(
    changes: readonly GlobalDreamingMemoryChange[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.embedder) return;
    for (const change of changes) {
      change.embedding = await this.tryEmbed(change.content.trim().replaceAll(/\s+/g, " "), signal);
    }
  }

  private async tryEmbed(content: string, signal: AbortSignal): Promise<MemoryEmbedding | null> {
    if (!this.embedder) return null;
    try {
      const [vector] = await this.embedder.embed("document", [content], signal);
      if (!vector?.length || vector.some((value) => !Number.isFinite(value))) return null;
      const magnitude = Math.hypot(...vector);
      if (!magnitude) return null;
      return {
        modelId: this.embedder.modelId,
        dimensions: vector.length,
        values: vector.map((value) => value / magnitude),
      };
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return null;
    }
  }
}
