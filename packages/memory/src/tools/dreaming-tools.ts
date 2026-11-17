import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DREAMING_WIKI_NAME_PATTERN,
  type DreamingCandidate,
  type DreamingMemoryChange,
  type GlobalDreamingCandidate,
  MemoryEvidenceStatus,
  type MemoryRevision,
  type MemoryRevisionSource,
} from "../dreaming.js";
import type { MemoryRepository, MemoryService } from "../memory-service.js";
import { resolveDreamingRevision } from "../utils/dreaming-revision.js";

const EvidenceSchema = Type.Union(
  Object.values(MemoryEvidenceStatus).map((value) => Type.Literal(value)),
);
const SearchSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) });
const ReadMemorySchema = Type.Object({
  memoryId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
});
const ReadEventSchema = Type.Object({ sessionId: Type.String(), eventId: Type.String() });
const ReadWikiSchema = Type.Object({ name: Type.Optional(Type.String()) });
const DraftSchema = Type.Object({
  memoryId: Type.Union([Type.String(), Type.Null()]),
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  evidenceStatus: EvidenceSchema,
  candidateIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 30 }),
});
const WriteWikiSchema = Type.Object({
  name: Type.String(),
  content: Type.String({ maxLength: 40000 }),
});
const GlobalCandidateSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  evidence: Type.String({ minLength: 1, maxLength: 1000 }),
  candidateIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 30 }),
});

// 校验整理 Agent 提交的工具参数。
function validateToolInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error("Invalid Dreaming tool input");
  return value as Static<T>;
}

// 把工具结果转换为模型可读取的文本。
function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

// 为单次整理构造共享草案、来源和调用上限的专用工具。
export function createDreamingTools(options: {
  input: { workspaceId: string; sessionId: string; runId: string };
  signal: AbortSignal;
  candidates: DreamingCandidate[];
  candidateRuns: { sessionId: string; runId: string }[];
  files: Map<string, string>;
  changes: DreamingMemoryChange[];
  globalCandidates: GlobalDreamingCandidate[];
  sessions: { find(sessionId: string): { workspaceId: string } | null };
  events: {
    load(
      sessionId: string,
      signal?: AbortSignal,
    ): Promise<{ events: readonly { id: string; seq: number; runId?: string; data: unknown }[] }>;
  };
  memories: MemoryService;
  memoryStore: Pick<MemoryRepository, "find">;
  dreaming: {
    findRevision(memoryId: string, revision: number): MemoryRevision | null;
    listSources(memoryId: string, revision: number): MemoryRevisionSource[];
  };
  projectEventData: (data: unknown) => unknown;
  onLimit: () => void;
}): readonly AgentTool[] {
  const {
    input,
    signal,
    candidates,
    candidateRuns,
    files,
    changes,
    globalCandidates,
    sessions,
    events,
    memories,
    memoryStore,
    dreaming,
    projectEventData,
    onLimit,
  } = options;
  const allowed = new Map<
    string,
    { sessionId: string; runId: string; eventId: string; eventSeq: number }
  >();
  for (const [index, candidate] of candidates.entries()) {
    const origin = candidateRuns[index];
    if (!origin) throw new Error("Candidate run not found");
    for (const source of candidate.sources)
      allowed.set(`${origin.sessionId}:${source.eventId}`, {
        ...source,
        sessionId: origin.sessionId,
        runId: origin.runId,
      });
  }
  let calls = 0;
  const count = () => {
    signal.throwIfAborted();
    if (++calls > 40) {
      onLimit();
      throw new Error("Dreaming tool limit exceeded");
    }
  };
  const tools: AgentTool[] = [
    {
      name: "search_memories",
      label: "Search memories",
      description: "Search workspace memories.",
      executionMode: "sequential",
      parameters: SearchSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(SearchSchema, value);
        return result(
          (await memories.searchForDreaming(args.query, input.workspaceId, 20, signal)).filter(
            (memory) => memory.workspaceId === input.workspaceId,
          ),
        );
      },
    },
    {
      name: "read_memory",
      label: "Read memory",
      description: "Read a workspace memory, its versions and source references.",
      executionMode: "sequential",
      parameters: ReadMemorySchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadMemorySchema, value);
        const memory = memoryStore.find(args.memoryId);
        if (!memory || memory.workspaceId !== input.workspaceId)
          throw new Error("Memory not found");
        const revision = dreaming.findRevision(args.memoryId, args.revision);
        if (!revision && memory.revision !== args.revision) throw new Error("Revision not found");
        const sources = dreaming.listSources(args.memoryId, args.revision);
        for (const source of sources) allowed.set(`${source.sessionId}:${source.eventId}`, source);
        return result({ memory, revision, sources });
      },
    },
    {
      name: "read_event",
      label: "Read source event",
      description: "Read an event referenced by a candidate or a memory already read.",
      executionMode: "sequential",
      parameters: ReadEventSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadEventSchema, value);
        const source = allowed.get(`${args.sessionId}:${args.eventId}`);
        if (!source || sessions.find(args.sessionId)?.workspaceId !== input.workspaceId)
          throw new Error("Source not allowed");
        const event = (await events.load(args.sessionId, signal)).events.find(
          (item) =>
            item.id === source.eventId &&
            item.seq === source.eventSeq &&
            item.runId === source.runId,
        );
        if (!event) throw new Error("Source event not found");
        return result({ ...event, data: projectEventData(event.data) });
      },
    },
    {
      name: "read_wiki",
      label: "Read Wiki",
      description: "Read a Wiki file, or list files if name is omitted.",
      executionMode: "sequential",
      parameters: ReadWikiSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadWikiSchema, value);
        return result(args.name === undefined ? [...files.keys()] : (files.get(args.name) ?? null));
      },
    },
    {
      name: "draft_memory",
      label: "Draft memory",
      description: "Create or update a workspace memory, using indexes of supporting candidates.",
      executionMode: "sequential",
      parameters: DraftSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(DraftSchema, value);
        const memory = args.memoryId === null ? null : memoryStore.find(args.memoryId);
        if (args.memoryId !== null && (!memory || memory.workspaceId !== input.workspaceId))
          throw new Error("Memory not found");
        const sources = args.candidateIndexes.flatMap((i) => {
          const candidate = candidates[i];
          const origin = candidateRuns[i];
          if (!candidate || !origin) throw new Error("Candidate not found");
          return candidate.sources.map((source) => ({
            ...source,
            sessionId: origin.sessionId,
            runId: origin.runId,
          }));
        });
        const memoryId = memory?.id ?? randomUUID();
        if (changes.some((item) => item.memoryId === memoryId))
          throw new Error("Memory already drafted");
        const change: DreamingMemoryChange = {
          memoryId,
          expectedRevision: memory?.revision ?? null,
          content: args.content,
          applicability: args.applicability,
          evidenceStatus: args.evidenceStatus,
          sources,
        };
        changes.push(change);
        const prior = memory ? dreaming.findRevision(memory.id, memory.revision) : null;
        const priorSources = memory ? dreaming.listSources(memory.id, memory.revision) : [];
        return result({
          memoryId,
          revision: resolveDreamingRevision(change, memory, prior, priorSources),
        });
      },
    },
    {
      name: "propose_global_memory",
      label: "Propose global memory",
      description:
        "Propose a durable cross-project memory supported by candidate indexes; omit if none qualifies.",
      executionMode: "sequential",
      parameters: GlobalCandidateSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(GlobalCandidateSchema, value);
        if (globalCandidates.length >= 30) throw new Error("Too many global candidates");
        const sources = args.candidateIndexes.flatMap((index) => {
          const candidate = candidates[index];
          const origin = candidateRuns[index];
          if (!candidate || !origin) throw new Error("Candidate not found");
          return candidate.sources.map((source) => ({ ...source, ...origin }));
        });
        globalCandidates.push({
          content: args.content,
          applicability: args.applicability,
          evidence: args.evidence,
          sources,
        });
        return result({ accepted: true });
      },
    },
    {
      name: "write_wiki",
      label: "Write Wiki draft",
      description: "Write one Markdown file: context.md, index.md or a topic filename.",
      executionMode: "sequential",
      parameters: WriteWikiSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(WriteWikiSchema, value);
        if (!DREAMING_WIKI_NAME_PATTERN.test(args.name)) throw new Error("Invalid Wiki filename");
        files.set(args.name, args.content);
        return result({ name: args.name });
      },
    },
  ];

  return tools;
}
