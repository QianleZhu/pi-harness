import { randomUUID } from "node:crypto";
import { type ContextCompactedData, createAgent, projectContext } from "@pi-harness/agent-runtime";
import {
  createGlobalDreamingTools,
  GLOBAL_DREAMING_PROMPT,
  type GlobalDreamingCandidate,
  type GlobalDreamingMemoryChange,
} from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { ProviderService } from "./provider-service.js";

// 串行整理跨工作区候选，提交前复查 user 记忆的发布版本。
export class GlobalDreamingService {
  private readonly queue: { workspaceId: string; candidate: GlobalDreamingCandidate }[] = [];
  public constructor(
    private readonly dreaming: SqliteDreamingRepository,
    private readonly sessions: SessionRepository,
    private readonly providers: ProviderService,
  ) {}

  // 工作区发布成功后，将候选放入 Worker 内存队列。
  public enqueue(workspaceId: string, candidates: readonly GlobalDreamingCandidate[]): void {
    this.queue.push(...candidates.map((candidate) => ({ workspaceId, candidate })));
  }

  // 判断是否有候选等待全局整理。
  public hasPending(): boolean {
    return this.queue.length > 0;
  }

  // 本批无有效变更时只完成候选，不生成全局版本。
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
    const current = this.dreaming.getGlobalVersion();
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
        memories: current.memories,
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
          memoryCount: current.memories.length,
          candidates: batch.map(({ candidate }) => ({
            content: candidate.content,
            applicability: candidate.applicability,
            evidence: candidate.evidence,
          })),
        }),
      );
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const last = agent.state.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop")
      throw new Error("Global Dreaming failed");
    if (
      !this.dreaming.publishGlobal({
        expectedVersion: current.version,
        changes,
        now: Date.now(),
      })
    )
      this.queue.unshift(...batch);
  }
}
