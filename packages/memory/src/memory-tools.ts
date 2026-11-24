import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolPermission, type ToolPolicy } from "@pi-harness/policy";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MemoryEvidenceStatus } from "./dreaming.js";
import type { MemoryRuntime, RunMemorySnapshot } from "./memory-service.js";

const TOOL_TIMEOUT_MS = 30_000;
const MEMORY_TOOL_SOURCE = "memory";
// 记忆检索工具名称供 Agent 工具注册和子 Agent 授权共用。
export const SEARCH_MEMORIES_TOOL_NAME = "search_memories";
export const RECORD_MEMORY_TOOL_NAME = "record_memory";

const SearchMemoriesParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: 50, minimum: 1 })),
  query: Type.String({ maxLength: 500, minLength: 1 }),
});
const RecordableEvidenceStatus = Type.Union([
  Type.Literal(MemoryEvidenceStatus.USER_STATED),
  Type.Literal(MemoryEvidenceStatus.PRACTICED),
  Type.Literal(MemoryEvidenceStatus.UNVERIFIED),
]);
const RecordMemoryParameters = Type.Object({
  applicability: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  content: Type.String({ maxLength: 500, minLength: 1 }),
  evidenceStatus: RecordableEvidenceStatus,
});

export interface MemoryToolRegistration {
  policy: ToolPolicy;
  source: string;
  timeoutMs: number;
  tool: AgentTool;
}

function textResult(value: unknown) {
  return { content: [{ text: JSON.stringify(value), type: "text" as const }], details: value };
}

function createSearchTool(
  memory: MemoryRuntime,
  workspaceId: string,
  getSnapshot: () => RunMemorySnapshot | null,
): AgentTool<typeof SearchMemoriesParameters> {
  return {
    description:
      "检索当前 Workspace 可见的长期记忆，返回记忆 ID、revision、scope 和内容。上下文中没有所需记忆时使用。",
    executionMode: "parallel",
    label: "Search memories",
    name: SEARCH_MEMORIES_TOOL_NAME,
    parameters: SearchMemoriesParameters,
    async execute(_toolCallId, input, signal) {
      return textResult(
        await memory.search(input.query, workspaceId, input.limit, signal, getSnapshot()),
      );
    },
  };
}

function createRecordMemoryTool(
  memory: MemoryRuntime,
  sessionId: string,
  workspaceId: string,
  getRunId: () => string | null,
): AgentTool<typeof RecordMemoryParameters> {
  return {
    description:
      "在工作过程中记录当前工作区值得后续复用的项目事实、决策或经验。内容会写入当前会话的在线暂存表，在同会话后续 Run 启动时自动拼入上下文，并由 Dreaming 后续用会话日志校验整理。不要保存秘密、临时进度、工作区已有明确规则或跨项目用户个性。",
    executionMode: "sequential",
    label: "Record memory",
    name: RECORD_MEMORY_TOOL_NAME,
    parameters: RecordMemoryParameters,
    async execute(_toolCallId, input, signal) {
      const runId = getRunId();
      if (!runId) throw new Error("MEMORY_INVALID: 当前没有活动 Run");
      return textResult(
        await memory.recordMemory(
          {
            ...input,
            sessionId,
            workspaceId,
            runId,
          },
          signal,
        ),
      );
    },
  };
}

function learningPolicy(
  memory: MemoryRuntime,
  parameters: typeof RecordMemoryParameters,
  summary: string,
  risk: string,
  target: (args: unknown) => string,
): ToolPolicy {
  return {
    allowInFullAccess: true,
    permission: ToolPermission.USER_APPROVAL,
    resolveGrant(args) {
      if (!Value.Check(parameters, args)) throw new Error("MEMORY_INVALID: 无效记忆参数");
      const settings = memory.getSettings();
      return {
        allowSession: false,
        allowSimilar: false,
        ...(settings.generateMemories
          ? {}
          : { denyReason: "MEMORY_LEARNING_DISABLED: 已关闭生成记忆" }),
        fingerprint: JSON.stringify(args),
        isGranted: settings.generateMemories,
        risk,
        summary,
        target: target(args),
      };
    },
  };
}

export function createMemoryToolRegistrations(
  memory: MemoryRuntime,
  sessionId: string,
  workspaceId: string,
  getSnapshot: () => RunMemorySnapshot | null = () => null,
  getRunId: () => string | null = () => null,
): readonly MemoryToolRegistration[] {
  const search = createSearchTool(memory, workspaceId, getSnapshot);
  const record = createRecordMemoryTool(memory, sessionId, workspaceId, getRunId);
  return [
    {
      policy: { permission: ToolPermission.READ_ONLY },
      source: MEMORY_TOOL_SOURCE,
      timeoutMs: TOOL_TIMEOUT_MS,
      tool: search,
    },
    {
      policy: learningPolicy(
        memory,
        RecordMemoryParameters,
        "记录工作区暂存记忆",
        "该内容会写入当前会话的在线暂存区，供同会话后续对话参考，并等待 Dreaming 用会话日志校验整理。",
        (args) => (args as Static<typeof RecordMemoryParameters>).content,
      ),
      source: MEMORY_TOOL_SOURCE,
      timeoutMs: TOOL_TIMEOUT_MS,
      tool: record,
    },
  ];
}
