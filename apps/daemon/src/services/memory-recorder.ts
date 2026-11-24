import { randomUUID } from "node:crypto";
import {
  MemoryEvidenceStatus,
  type MemoryRecorder,
  type RecordedMemory,
  type RecordMemoryInput,
} from "@pi-harness/memory";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import { ID_PATTERN } from "../utils/dreaming-wiki.js";

const RECORDABLE_EVIDENCE_STATUSES = new Set<string>([
  MemoryEvidenceStatus.USER_STATED,
  MemoryEvidenceStatus.PRACTICED,
  MemoryEvidenceStatus.UNVERIFIED,
]);

function normalizeContent(content: string): string {
  const trimmed = content.trim().replaceAll(/\s+/g, " ");
  if (!trimmed || trimmed.length > 500) throw new Error("记忆内容长度必须为 1 到 500 个字符");
  return trimmed;
}

function normalizeApplicability(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replaceAll(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length > 500) throw new Error("记忆适用条件不能超过 500 个字符");
  return trimmed;
}

// 主 Agent 仅向独立暂存表追加待审工作区记忆，不写正式 memories 表，也不修改 context.md。
export class MemoryRecorderService implements MemoryRecorder {
  public constructor(
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: SqliteMemoryRepository,
  ) {}

  public async record(input: RecordMemoryInput, signal?: AbortSignal): Promise<RecordedMemory> {
    signal?.throwIfAborted();
    if (!ID_PATTERN.test(input.workspaceId)) throw new Error("Invalid workspace ID");
    if (!ID_PATTERN.test(input.sessionId)) throw new Error("Invalid session ID");
    if (!input.runId.trim()) throw new Error("Invalid run ID");
    if (!this.memories.hasWorkspace(input.workspaceId)) throw new Error("Workspace not found");
    if (!RECORDABLE_EVIDENCE_STATUSES.has(input.evidenceStatus))
      throw new Error("Invalid evidence status");
    const content = normalizeContent(input.content);
    const applicability = normalizeApplicability(input.applicability);
    return this.dreaming.createProvisionalMemory({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      content,
      normalizedContent: content.toLocaleLowerCase(),
      applicability,
      evidenceStatus: input.evidenceStatus,
      now: Date.now(),
    });
  }
}
