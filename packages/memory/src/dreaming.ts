import type { UserProfileFacet } from "./contract.js";
import type { MemoryEmbedding } from "./memory-service.js";

// Dreaming 保存的记忆版本及其证据状态。
export const MemoryEvidenceStatus = {
  USER_STATED: "user_stated",
  PRACTICED: "practiced",
  UNVERIFIED: "unverified",
  CONFLICTED: "conflicted",
  SUPERSEDED: "superseded",
} as const;
export type MemoryEvidenceStatus = (typeof MemoryEvidenceStatus)[keyof typeof MemoryEvidenceStatus];

export interface MemoryRevision {
  memoryId: string;
  revision: number;
  content: string;
  applicability: string | null;
  evidenceStatus: MemoryEvidenceStatus;
  createdAt: number;
}

export interface MemoryRevisionSource {
  memoryId: string;
  revision: number;
  sessionId: string;
  runId: string;
  eventId: string;
  eventSeq: number;
}

// 工作区整理提出的跨项目候选，来源指向已验证的会话事件。
export interface GlobalDreamingCandidate {
  content: string;
  applicability: string | null;
  evidence: string;
  sources: Omit<MemoryRevisionSource, "memoryId" | "revision">[];
}

export interface DreamingMemoryChange {
  memoryId: string;
  expectedRevision: number | null;
  content: string;
  applicability: string | null;
  evidenceStatus: MemoryEvidenceStatus;
  sources: Omit<MemoryRevisionSource, "memoryId" | "revision">[];
  embedding?: MemoryEmbedding | null;
}

// 全局整理草案的画像分类为空时表示跨项目经验。
export interface GlobalDreamingMemoryChange extends DreamingMemoryChange {
  profileFacet: UserProfileFacet | null;
}

// Wiki 草案只接受单层 Markdown 文件名。
export const DREAMING_WIKI_NAME_PATTERN = /^(?:index|context|[a-z0-9][a-z0-9_-]{0,63})\.md$/;

// Agent 在 Run 中主动记录的工作区记忆，后续由 Dreaming 用会话日志校验。
export interface RecordMemoryInput {
  workspaceId: string;
  sessionId: string;
  runId: string;
  content: string;
  applicability: string | null;
  evidenceStatus: MemoryEvidenceStatus;
}

export interface RecordedMemory {
  memoryId: string;
  revision: number;
  created: boolean;
  contextUpdated: boolean;
}

// 主动记录的记忆在第一层单独隔开，Dreaming 后续负责校验和整理。
export const RECORDED_MEMORY_CONTEXT_HEADING = "## 当前运行记录的长期记忆";

// 一个 Run 在 Dreaming 工作流中的状态。
export const DreamingRunStatus = {
  WAITING: "waiting",
  PENDING: "pending",
  ANALYZING: "analyzing",
  PENDING_CONSOLIDATION: "pending_consolidation",
  CONSOLIDATING: "consolidating",
  COMPLETED: "completed",
  NO_CANDIDATES: "no_candidates",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;
export type DreamingRunStatus = (typeof DreamingRunStatus)[keyof typeof DreamingRunStatus];
