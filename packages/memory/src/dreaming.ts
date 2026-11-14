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
