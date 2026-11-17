import { type HarnessEvent, HarnessEventType } from "@pi-harness/agent-runtime";
import type { DreamingCandidate } from "@pi-harness/memory";
import { isPlainObject } from "es-toolkit";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// 限制候选内容与模型输出规模，避免无界结果进入整理阶段。
const CandidateSchema = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 500 }),
    applicability: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    evidence: Type.String({ minLength: 1, maxLength: 1000 }),
    eventIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 30,
    }),
  },
  { additionalProperties: false },
);
const AnalysisSchema = Type.Object(
  {
    candidates: Type.Array(CandidateSchema, { maxItems: 30 }),
  },
  { additionalProperties: false },
);
const StoredCandidateSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  evidence: Type.String({ minLength: 1, maxLength: 1000 }),
  sources: Type.Array(
    Type.Object({
      eventId: Type.String({ minLength: 1, maxLength: 128 }),
      eventSeq: Type.Integer({ minimum: 1 }),
    }),
    { minItems: 1, maxItems: 30 },
  ),
});
const StoredCandidatesSchema = Type.Array(StoredCandidateSchema, { minItems: 1, maxItems: 30 });

// 恢复已经通过来源校验并持久化的 Run 候选。
export function readStoredCandidates(value: string): DreamingCandidate[] {
  const parsed: unknown = JSON.parse(value);
  if (!Value.Check(StoredCandidatesSchema, parsed))
    throw new Error("Invalid stored Dreaming candidates");
  return parsed as DreamingCandidate[];
}

// 去除图片等非文本内容，仅保留可分析的文本及工具参数。
export function textData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textData).filter((item) => item !== undefined);
  if (!isPlainObject(value)) return value;
  if (value.type === "image" || value.type === "image_url") return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const projected = textData(item);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

// 选择指定 Run 的文本事件，排除运行时系统提示和工具定义。
export function selectRunEvents(events: readonly HarnessEvent[], runId: string): HarnessEvent[] {
  const types = new Set<string>([
    HarnessEventType.MESSAGE_COMPLETED,
    HarnessEventType.TOOL_STARTED,
    HarnessEventType.TOOL_COMPLETED,
    HarnessEventType.TOOL_FAILED,
    HarnessEventType.RUN_COMPLETED,
    HarnessEventType.RUN_FAILED,
    HarnessEventType.RUN_ABORTED,
  ]);
  const selected = events.filter((event) => event.runId === runId && types.has(event.type));
  const started = events.filter(
    (event) => event.runId === runId && event.type === HarnessEventType.RUN_STARTED,
  );
  const terminal = selected.filter((event) =>
    [
      HarnessEventType.RUN_COMPLETED,
      HarnessEventType.RUN_FAILED,
      HarnessEventType.RUN_ABORTED,
    ].some((type) => type === event.type),
  );
  const start = started[0];
  const end = terminal[0];
  if (started.length !== 1 || terminal.length !== 1 || !start || !end || end.seq <= start.seq) {
    throw new Error("Dreaming run must have one start and one terminal event");
  }
  return selected.filter((event) => event.seq >= start.seq && event.seq <= end.seq);
}

// 校验模型候选并将事件 ID 映射为实际输入的事件序号。
export function readCandidates(
  output: string,
  events: readonly HarnessEvent[],
): DreamingCandidate[] {
  const parsed: unknown = JSON.parse(output);
  if (!Value.Check(AnalysisSchema, parsed)) throw new Error("Invalid Dreaming candidate output");
  const byId = new Map(events.map((event) => [event.id, event.seq]));
  return (parsed as Static<typeof AnalysisSchema>).candidates.map((candidate) => ({
    content: candidate.content,
    applicability: candidate.applicability,
    evidence: candidate.evidence,
    sources: [...new Set(candidate.eventIds)].map((eventId) => {
      const eventSeq = byId.get(eventId);
      if (eventSeq === undefined) throw new Error("Dreaming candidate references an unknown event");
      return { eventId, eventSeq };
    }),
  }));
}
