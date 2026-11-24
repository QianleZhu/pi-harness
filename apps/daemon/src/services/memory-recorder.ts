import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DreamingMemoryChange,
  type MemoryEmbedder,
  type MemoryEmbedding,
  MemoryEvidenceStatus,
  type MemoryRecorder,
  MemoryScope,
  RECORDED_MEMORY_CONTEXT_HEADING,
  type RecordedMemory,
  type RecordMemoryInput,
} from "@pi-harness/memory";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";
import {
  contextDirectory,
  DEFAULT_MEMORY_CONTEXT,
  ID_PATTERN,
  readContextFile,
} from "../utils/dreaming-wiki.js";

const CONTEXT_BUDGET = 2_000;

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

// 在第一层末尾追加独立区块，只保留记忆内容，不改动原有正文。
function appendContextEntry(context: string, content: string): string | null {
  const bullet = `- ${content}`;
  const newline = context.includes("\r\n") ? "\r\n" : "\n";
  const lines = context.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === RECORDED_MEMORY_CONTEXT_HEADING);
  let nextLines: string[];
  if (headingIndex < 0) {
    nextLines = [...lines, "", RECORDED_MEMORY_CONTEXT_HEADING, "", bullet];
  } else {
    let end = lines.length;
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^#{1,2}\s/.test(lines[index] ?? "")) {
        end = index;
        break;
      }
    }
    if (lines.slice(headingIndex + 1, end).some((line) => line.trim() === bullet)) return context;
    nextLines = [...lines.slice(0, end), "", bullet, ...lines.slice(end)];
  }
  const next = `${nextLines.join(newline).trimEnd()}${newline}`;
  return next.length <= CONTEXT_BUDGET ? next : null;
}

// 主 Agent 写入工作区记忆摘要，并生成新的上下文版本副本。
export class MemoryRecorderService implements MemoryRecorder {
  public constructor(
    private readonly root: string,
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: SqliteMemoryRepository,
    private readonly embedder: MemoryEmbedder,
  ) {}

  // 记录到第三层记忆摘要；重复内容复用现有记忆，来源由 Dreaming 后续补充。
  public async record(input: RecordMemoryInput, signal?: AbortSignal): Promise<RecordedMemory> {
    if (!ID_PATTERN.test(input.workspaceId)) throw new Error("Invalid workspace ID");
    if (!this.memories.hasWorkspace(input.workspaceId)) throw new Error("Workspace not found");
    if (!Object.values(MemoryEvidenceStatus).includes(input.evidenceStatus))
      throw new Error("Invalid evidence status");
    const content = normalizeContent(input.content);
    const existing = this.memories.findDuplicate(
      content.toLocaleLowerCase(),
      MemoryScope.WORKSPACE,
      input.workspaceId,
    );
    const change: DreamingMemoryChange = {
      memoryId: existing?.id ?? randomUUID(),
      expectedRevision: existing?.revision ?? null,
      content,
      applicability: normalizeApplicability(input.applicability),
      evidenceStatus: input.evidenceStatus,
      sources: [],
    };
    const embedding = await this.tryEmbed(content, signal);
    if (embedding) change.embedding = embedding;
    const result = this.dreaming.recordWorkspaceMemory({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      change,
      now: Date.now(),
    });
    const contextUpdated = await this.updateContext(input.workspaceId, content, signal);
    return { ...result, contextUpdated };
  }

  // 追加到最新上下文副本并发布新版本；已发布副本保持不变。
  private async updateContext(
    workspaceId: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      const current = this.dreaming.findContext(workspaceId);
      const existing = current
        ? await readContextFile(contextDirectory(this.root, workspaceId, current.directoryId))
        : null;
      const base = existing?.trim() ? existing : DEFAULT_MEMORY_CONTEXT;
      const context = appendContextEntry(base, content);
      if (context === null) return false;
      if (context === base) return true;
      const directoryId = randomUUID();
      const directory = contextDirectory(this.root, workspaceId, directoryId);
      await mkdir(directory, { mode: 0o700, recursive: true });
      try {
        await writeFile(join(directory, "context.md"), context, {
          encoding: "utf8",
          mode: 0o600,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (
          this.dreaming.publishContext({
            workspaceId,
            directoryId,
            expectedDirectoryId: current?.directoryId ?? null,
            now: Date.now(),
          })
        )
          return true;
      } catch (error: unknown) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      await rm(directory, { recursive: true, force: true });
    }
    throw new Error("Dreaming context changed");
  }

  // 向量失败时保留关键词召回，不阻止记忆写入。
  private async tryEmbed(content: string, signal?: AbortSignal): Promise<MemoryEmbedding | null> {
    try {
      const [vector] = await this.embedder.embed("document", [content], signal);
      if (!vector?.length || vector.some((value) => !Number.isFinite(value))) return null;
      const magnitude = Math.hypot(...vector);
      if (!magnitude) return null;
      return {
        dimensions: vector.length,
        modelId: this.embedder.modelId,
        values: vector.map((value) => value / magnitude),
      };
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      return null;
    }
  }
}
