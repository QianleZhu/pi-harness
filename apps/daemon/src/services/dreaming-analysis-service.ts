import { DREAMING_ANALYSIS_PROMPT, type DreamingCandidate } from "@pi-harness/memory";
import type { SessionRepository } from "../storage/database.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import { readCandidates, selectRunEvents, textData } from "../utils/dreaming-analysis.js";
import type { ProviderService } from "./provider-service.js";

// 对单个已结束的 Run 发起一次候选提取调用。
export class DreamingAnalysisService {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly eventStore: SessionEventStore,
    private readonly providers: ProviderService,
  ) {}

  public async analyze(
    input: {
      workspaceId: string;
      sessionId: string;
      runId: string;
      providerId: string;
      modelId: string;
      signal?: AbortSignal;
    },
    resolvedModel?: Awaited<ReturnType<ProviderService["resolveRunModel"]>>,
  ): Promise<DreamingCandidate[]> {
    const session = this.sessions.find(input.sessionId);
    if (!session || session.workspaceId !== input.workspaceId)
      throw new Error("Dreaming session not found in workspace");
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const snapshot = await this.eventStore.load(input.sessionId, signal);
    const events = selectRunEvents(snapshot.events, input.runId);
    const { model, streamFn } =
      resolvedModel ?? (await this.providers.resolveRunModel(input.providerId, input.modelId));
    signal.throwIfAborted();
    const stream = streamFn(
      model,
      {
        systemPrompt: DREAMING_ANALYSIS_PROMPT,
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: JSON.stringify(
              events.map((event) => ({
                id: event.id,
                seq: event.seq,
                type: event.type,
                data: textData(event.data),
              })),
            ),
          },
        ],
      },
      { signal, timeoutMs: 120_000, maxRetries: 0 },
    );
    const response = await stream.result();
    if (response.stopReason !== "stop") throw new Error("Dreaming analysis failed");
    const output = response.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    return readCandidates(output, events);
  }
}
