import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { MemoryRecord } from "../contract.js";
import {
  type GlobalDreamingCandidate,
  type GlobalDreamingMemoryChange,
  MemoryEvidenceStatus,
  type MemoryRevision,
  type MemoryRevisionSource,
} from "../dreaming.js";

const DraftSchema = Type.Object({
  memoryId: Type.Union([Type.String(), Type.Null()]),
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  evidenceStatus: Type.Union(
    Object.values(MemoryEvidenceStatus).map((value) => Type.Literal(value)),
  ),
  candidateIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 30 }),
});
const InspectSchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
const ListDraftsSchema = Type.Object({});
const DropDraftSchema = Type.Object({
  memoryId: Type.String({ minLength: 1, maxLength: 128 }),
});
const MAX_GLOBAL_TOOL_CALLS = 120;

// 限制全局 Agent 只能引用本批候选和当前生效快照中的记忆；支持增量合并轮次更新或撤销草案。
export function createGlobalDreamingTools(options: {
  getMemories: () => readonly MemoryRecord[];
  candidates: readonly GlobalDreamingCandidate[];
  changes: GlobalDreamingMemoryChange[];
  readRevision: (memoryId: string, revision: number) => MemoryRevision | null;
  readSources: (memoryId: string, revision: number) => MemoryRevisionSource[];
  signal: AbortSignal;
  onLimit: () => void;
}): readonly AgentTool[] {
  let calls = 0;
  const count = () => {
    options.signal.throwIfAborted();
    if (++calls > MAX_GLOBAL_TOOL_CALLS) {
      options.onLimit();
      throw new Error("Global Dreaming tool limit exceeded");
    }
  };
  return [
    {
      name: "inspect_global_memories",
      label: "Inspect global memories",
      description:
        "Search current global memories by text, or page through all memories with an empty query.",
      executionMode: "sequential",
      parameters: InspectSchema,
      async execute(_id, value) {
        count();
        if (!Value.Check(InspectSchema, value)) throw new Error("Invalid global memory query");
        const args = value as Static<typeof InspectSchema>;
        const query = args.query?.trim().toLocaleLowerCase() ?? "";
        const matches = options
          .getMemories()
          .filter((memory) => memory.content.toLocaleLowerCase().includes(query));
        const offset = args.offset ?? 0;
        const result = {
          total: matches.length,
          memories: matches.slice(offset, offset + 30).map((memory) => ({
            memory,
            revision: options.readRevision(memory.id, memory.revision),
            sources: options.readSources(memory.id, memory.revision),
          })),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    {
      name: "list_global_drafts",
      label: "List global drafts",
      description: "List all currently drafted global memory changes in this consolidation batch.",
      executionMode: "sequential",
      parameters: ListDraftsSchema,
      async execute(_id, value) {
        count();
        if (!Value.Check(ListDraftsSchema, value)) throw new Error("Invalid draft list query");
        const result = options.changes.map((change) => ({
          memoryId: change.memoryId,
          expectedRevision: change.expectedRevision,
          content: change.content,
          applicability: change.applicability,
          evidenceStatus: change.evidenceStatus,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    {
      name: "draft_global_memory",
      label: "Draft global memory",
      description:
        "Create, update, or replace a draft for a cross-project global memory, citing candidate indexes. Do not store personal user profile items here.",
      executionMode: "sequential",
      parameters: DraftSchema,
      async execute(_id, value) {
        count();
        if (!Value.Check(DraftSchema, value)) throw new Error("Invalid global memory draft");
        const args = value as Static<typeof DraftSchema>;
        const currentMemories = options.getMemories();
        const existingMemory =
          args.memoryId === null
            ? null
            : (currentMemories.find((item) => item.id === args.memoryId) ?? null);
        const existingDraftIndex =
          args.memoryId === null
            ? -1
            : options.changes.findIndex((change) => change.memoryId === args.memoryId);
        if (args.memoryId !== null && !existingMemory && existingDraftIndex < 0) {
          throw new Error("Global memory not found");
        }
        const memoryId = existingMemory?.id ?? args.memoryId ?? randomUUID();
        const sources = args.candidateIndexes.flatMap((index) => {
          const candidate = options.candidates[index];
          if (!candidate) throw new Error("Global candidate not found");
          return candidate.sources;
        });
        const nextChange: GlobalDreamingMemoryChange = {
          memoryId,
          expectedRevision: existingMemory?.revision ?? null,
          content: args.content,
          applicability: args.applicability,
          evidenceStatus: args.evidenceStatus,
          sources,
        };
        if (existingDraftIndex >= 0) {
          options.changes[existingDraftIndex] = nextChange;
        } else {
          options.changes.push(nextChange);
        }
        const result = {
          memoryId,
          expectedRevision: nextChange.expectedRevision,
          replaced: existingDraftIndex >= 0,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    {
      name: "drop_global_draft",
      label: "Drop global draft",
      description:
        "Withdraw a previously drafted global memory change (for example when superseded by a concurrent user edit or deletion).",
      executionMode: "sequential",
      parameters: DropDraftSchema,
      async execute(_id, value) {
        count();
        if (!Value.Check(DropDraftSchema, value)) throw new Error("Invalid drop draft input");
        const args = value as Static<typeof DropDraftSchema>;
        const index = options.changes.findIndex((change) => change.memoryId === args.memoryId);
        if (index < 0) throw new Error("Global draft not found");
        options.changes.splice(index, 1);
        const result = { dropped: true, memoryId: args.memoryId };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
  ];
}
