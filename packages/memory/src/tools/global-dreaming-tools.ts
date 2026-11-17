import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type MemoryRecord, UserProfileFacetSchema } from "../contract.js";
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
  profileFacet: Type.Union([UserProfileFacetSchema, Type.Null()]),
  candidateIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 30 }),
});
const InspectSchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

// 限制全局 Agent 只能引用本批候选和固定版本中的记忆。
export function createGlobalDreamingTools(options: {
  memories: readonly MemoryRecord[];
  candidates: readonly GlobalDreamingCandidate[];
  changes: GlobalDreamingMemoryChange[];
  readRevision: (memoryId: string, revision: number) => MemoryRevision | null;
  readSources: (memoryId: string, revision: number) => MemoryRevisionSource[];
  signal: AbortSignal;
  onLimit: () => void;
}): readonly AgentTool[] {
  let calls = 0;
  return [
    {
      name: "inspect_global_memories",
      label: "Inspect global memories",
      description:
        "Search current global memories by text, or page through all memories with an empty query.",
      executionMode: "sequential",
      parameters: InspectSchema,
      async execute(_id, value) {
        options.signal.throwIfAborted();
        if (++calls > 40) {
          options.onLimit();
          throw new Error("Global Dreaming tool limit exceeded");
        }
        if (!Value.Check(InspectSchema, value)) throw new Error("Invalid global memory query");
        const args = value as Static<typeof InspectSchema>;
        const query = args.query?.trim().toLocaleLowerCase() ?? "";
        const matches = options.memories.filter((memory) =>
          memory.content.toLocaleLowerCase().includes(query),
        );
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
      name: "draft_global_memory",
      label: "Draft global memory",
      description:
        "Create or update user memory, citing candidate indexes; profileFacet=null denotes cross-project experience.",
      executionMode: "sequential",
      parameters: DraftSchema,
      async execute(_id, value) {
        options.signal.throwIfAborted();
        if (++calls > 40) {
          options.onLimit();
          throw new Error("Global Dreaming tool limit exceeded");
        }
        if (!Value.Check(DraftSchema, value)) throw new Error("Invalid global memory draft");
        const args = value as Static<typeof DraftSchema>;
        const memory =
          args.memoryId === null
            ? null
            : options.memories.find((item) => item.id === args.memoryId);
        if (args.memoryId !== null && !memory) throw new Error("Global memory not found");
        const memoryId = memory?.id ?? randomUUID();
        if (options.changes.some((change) => change.memoryId === memoryId))
          throw new Error("Memory already drafted");
        const sources = args.candidateIndexes.flatMap((index) => {
          const candidate = options.candidates[index];
          if (!candidate) throw new Error("Global candidate not found");
          return candidate.sources;
        });
        options.changes.push({
          memoryId,
          expectedRevision: memory?.revision ?? null,
          content: args.content,
          applicability: args.applicability,
          evidenceStatus: args.evidenceStatus,
          profileFacet: args.profileFacet,
          sources,
        });
        const result = { memoryId };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
  ];
}
