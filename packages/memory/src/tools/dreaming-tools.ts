import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DREAMING_WIKI_NAME_PATTERN,
  type DreamingMemoryChange,
  type GlobalDreamingCandidate,
  MemoryEvidenceStatus,
  type MemoryRevision,
  type MemoryRevisionSource,
} from "../dreaming.js";
import type { MemoryRepository, MemoryService } from "../memory-service.js";
import { SEARCH_MEMORIES_TOOL_NAME } from "../memory-tools.js";
import { resolveDreamingRevision } from "../utils/dreaming-revision.js";

// 只依赖事件的可序列化结构，避免 memory 包反向依赖 agent-runtime。
interface DreamingEvent {
  id: string;
  seq: number;
  sessionId: string;
  runId?: string;
  timestamp: number;
  type: string;
  data: unknown;
}

const EvidenceSchema = Type.Union(
  Object.values(MemoryEvidenceStatus).map((value) => Type.Literal(value)),
);
const SearchSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: 50, minimum: 1 })),
  query: Type.String({ minLength: 1, maxLength: 500 }),
});
const ListMemoriesSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: 50, minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
const ReadMemorySchema = Type.Object({
  memoryId: Type.String(),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
});
const ReadEventSchema = Type.Object({
  eventId: Type.String(),
  runId: Type.String(),
});
const ReadRunSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: 30, minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  runId: Type.String(),
});
const ListRunsSchema = Type.Object({});
const ReadWikiSchema = Type.Object({ name: Type.Optional(Type.String()) });
const ReadContextSchema = Type.Object({});
const WriteContextSchema = Type.Object({
  content: Type.String({ maxLength: 2000 }),
});
const DraftSchema = Type.Object({
  memoryId: Type.Union([Type.String(), Type.Null()]),
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  evidenceStatus: EvidenceSchema,
  eventIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    minItems: 1,
    maxItems: 30,
  }),
});
const WriteWikiSchema = Type.Object({
  name: Type.String(),
  content: Type.String({ maxLength: 40000 }),
});
const GlobalCandidateSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 500 }),
  applicability: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  evidence: Type.String({ minLength: 1, maxLength: 1000 }),
  eventIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    minItems: 1,
    maxItems: 30,
  }),
});

const EVENT_PAGE_CHARACTERS = 12_000;
const MAX_EVENT_CHARACTERS = 12_000;
const MAX_TOOL_CALLS = 200;

// 校验整理 Agent 提交的工具参数。
function validateToolInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error("Invalid Dreaming tool input");
  return value as Static<T>;
}

// 把工具结果转换为模型可读取的文本。
function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

// 截断单个事件，避免单次工具输出超出上下文预算。
function projectEvent(event: DreamingEvent, projectEventData: (data: unknown) => unknown): unknown {
  const projected = projectEventData(event.data) ?? null;
  const data = JSON.stringify(projected);
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    data:
      data.length > MAX_EVENT_CHARACTERS
        ? `${data.slice(0, MAX_EVENT_CHARACTERS)}...[truncated]`
        : projected,
  };
}

// 为单次整理构造共享草案、事件索引和调用上限的专用工具。
export function createDreamingTools(options: {
  input: { workspaceId: string };
  signal: AbortSignal;
  runs: ReadonlyMap<string, readonly DreamingEvent[]>;
  readRuns: Set<string>;
  files: Map<string, string>;
  context: { content: string };
  changes: DreamingMemoryChange[];
  globalCandidates: GlobalDreamingCandidate[];
  sessions: { find(sessionId: string): { workspaceId: string } | null };
  events: {
    load(sessionId: string, signal?: AbortSignal): Promise<{ events: readonly DreamingEvent[] }>;
  };
  memories: MemoryService;
  memoryStore: Pick<MemoryRepository, "find" | "list">;
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
    runs,
    readRuns,
    files,
    context,
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
  const readEvents = new Set<string>();
  for (const [runId, runEvents] of runs)
    for (const event of runEvents)
      allowed.set(event.id, {
        eventId: event.id,
        eventSeq: event.seq,
        runId,
        sessionId: event.sessionId,
      });
  let calls = 0;
  const count = () => {
    signal.throwIfAborted();
    if (++calls > MAX_TOOL_CALLS) {
      onLimit();
      throw new Error("Dreaming tool limit exceeded");
    }
  };
  const sources = (eventIds: readonly string[]) =>
    eventIds.map((eventId) => {
      const source = allowed.get(eventId);
      if (!source) throw new Error("Event not allowed");
      if (sessions.find(source.sessionId)?.workspaceId !== input.workspaceId)
        throw new Error("Event not in workspace");
      if (!readEvents.has(eventId)) throw new Error("Event must be read before drafting");
      return source;
    });
  const tools: AgentTool[] = [
    {
      name: "list_runs",
      label: "List runs",
      description:
        "List every eligible run in this workspace batch, with session id and event count.",
      executionMode: "sequential",
      parameters: ListRunsSchema,
      execute: async (_id, value) => {
        count();
        validateToolInput(ListRunsSchema, value);
        return result(
          [...runs].map(([runId, runEvents]) => ({
            eventCount: runEvents.length,
            runId,
            sessionId: runEvents[0]?.sessionId ?? null,
          })),
        );
      },
    },
    {
      name: "read_run",
      label: "Read run events",
      description:
        "Read one eligible run's persisted events in pages. Use offset to continue; stop when nextOffset is null.",
      executionMode: "sequential",
      parameters: ReadRunSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadRunSchema, value);
        const runEvents = runs.get(args.runId);
        if (!runEvents) throw new Error("Run not found");
        readRuns.add(args.runId);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 12;
        const page: unknown[] = [];
        let characters = 0;
        for (let index = offset; index < runEvents.length && page.length < limit; index += 1) {
          const event = runEvents[index];
          if (!event) break;
          const projected = projectEvent(event, projectEventData);
          const size = JSON.stringify(projected).length;
          if (page.length > 0 && characters + size > EVENT_PAGE_CHARACTERS) break;
          page.push(projected);
          readEvents.add(event.id);
          characters += size;
        }
        const nextOffset = offset + page.length;
        return result({
          events: page,
          nextOffset: nextOffset < runEvents.length ? nextOffset : null,
          offset,
          runId: args.runId,
          total: runEvents.length,
        });
      },
    },
    {
      name: "read_event",
      label: "Read event",
      description: "Read one event referenced by a run, candidate memory source or draft.",
      executionMode: "sequential",
      parameters: ReadEventSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadEventSchema, value);
        const source = allowed.get(args.eventId);
        if (!source || source.runId !== args.runId) throw new Error("Source not allowed");
        if (sessions.find(source.sessionId)?.workspaceId !== input.workspaceId)
          throw new Error("Source not in workspace");
        readRuns.add(args.runId);
        const event = (await events.load(source.sessionId, signal)).events.find(
          (item) =>
            item.id === source.eventId &&
            item.seq === source.eventSeq &&
            item.runId === source.runId,
        );
        if (!event) throw new Error("Source event not found");
        readEvents.add(source.eventId);
        return result(projectEvent(event, projectEventData));
      },
    },
    {
      name: SEARCH_MEMORIES_TOOL_NAME,
      label: "Search memories",
      description: "Search workspace memories by text.",
      executionMode: "sequential",
      parameters: SearchSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(SearchSchema, value);
        return result(
          (
            await memories.searchForDreaming(
              args.query,
              input.workspaceId,
              args.limit ?? 20,
              signal,
            )
          ).filter((memory) => memory.workspaceId === input.workspaceId),
        );
      },
    },
    {
      name: "list_memories",
      label: "List memories",
      description: "Page through workspace memories without a query.",
      executionMode: "sequential",
      parameters: ListMemoriesSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ListMemoriesSchema, value);
        const all = memoryStore.list().filter((memory) => memory.workspaceId === input.workspaceId);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 20;
        return result({
          memories: all.slice(offset, offset + limit),
          nextOffset: offset + limit < all.length ? offset + limit : null,
          total: all.length,
        });
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
        const revisionNumber = args.revision ?? memory.revision;
        const revision = dreaming.findRevision(memory.id, revisionNumber);
        if (!revision && memory.revision !== revisionNumber) throw new Error("Revision not found");
        const memorySources = dreaming.listSources(memory.id, revisionNumber);
        for (const source of memorySources) allowed.set(source.eventId, source);
        return result({ memory, revision, sources: memorySources });
      },
    },
    {
      name: "read_wiki",
      label: "Read Wiki",
      description: "Read a Wiki file (index or topic), or list files if name is omitted.",
      executionMode: "sequential",
      parameters: ReadWikiSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(ReadWikiSchema, value);
        if (args.name === "context.md") throw new Error("Context is not part of the Wiki");
        return result(args.name === undefined ? [...files.keys()] : (files.get(args.name) ?? null));
      },
    },
    {
      name: "read_context",
      label: "Read context",
      description: "Read the current injected context draft.",
      executionMode: "sequential",
      parameters: ReadContextSchema,
      execute: async (_id, value) => {
        count();
        validateToolInput(ReadContextSchema, value);
        return result({ content: context.content });
      },
    },
    {
      name: "write_context",
      label: "Write context draft",
      description:
        "Replace the injected context draft. Keep a navigation link to index.md and remove processed provisional entries.",
      executionMode: "sequential",
      parameters: WriteContextSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(WriteContextSchema, value);
        context.content = args.content;
        return result({ characters: args.content.length });
      },
    },
    {
      name: "draft_memory",
      label: "Draft memory",
      description:
        "Create or update a workspace memory using supporting event ids. When a finding concerns an existing memory, pass its memoryId so the old revision is preserved.",
      executionMode: "sequential",
      parameters: DraftSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(DraftSchema, value);
        const memory = args.memoryId === null ? null : memoryStore.find(args.memoryId);
        if (args.memoryId !== null && (!memory || memory.workspaceId !== input.workspaceId))
          throw new Error("Memory not found");
        const memoryId = memory?.id ?? randomUUID();
        if (changes.some((item) => item.memoryId === memoryId))
          throw new Error("Memory already drafted");
        const change: DreamingMemoryChange = {
          memoryId,
          expectedRevision: memory?.revision ?? null,
          content: args.content,
          applicability: args.applicability,
          evidenceStatus: args.evidenceStatus,
          sources: sources(args.eventIds),
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
        "Propose a durable cross-project memory supported by event ids; omit if none qualifies.",
      executionMode: "sequential",
      parameters: GlobalCandidateSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(GlobalCandidateSchema, value);
        if (globalCandidates.length >= 30) throw new Error("Too many global candidates");
        globalCandidates.push({
          content: args.content,
          applicability: args.applicability,
          evidence: args.evidence,
          sources: sources(args.eventIds),
        });
        return result({ accepted: true });
      },
    },
    {
      name: "write_wiki",
      label: "Write Wiki draft",
      description: "Write one Wiki Markdown file: index.md or a topic filename.",
      executionMode: "sequential",
      parameters: WriteWikiSchema,
      execute: async (_id, value) => {
        count();
        const args = validateToolInput(WriteWikiSchema, value);
        if (!DREAMING_WIKI_NAME_PATTERN.test(args.name) || args.name === "context.md")
          throw new Error("Invalid Wiki filename");
        files.set(args.name, args.content);
        return result({ name: args.name });
      },
    },
  ];

  return tools;
}
