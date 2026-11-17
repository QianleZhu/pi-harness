import type { DreamingMemoryChange, MemoryRevision, MemoryRevisionSource } from "../dreaming.js";
import { MemoryEvidenceStatus } from "../dreaming.js";

// 记忆正文、证据或来源变化时生成不可变的新版本。
export function resolveDreamingRevision(
  change: DreamingMemoryChange,
  current: { content: string; revision: number } | null,
  previous: MemoryRevision | null,
  sources: readonly MemoryRevisionSource[],
): number {
  if (!current) return 1;
  const hasNewSource = change.sources.some(
    (source) =>
      !sources.some(
        (item) =>
          item.sessionId === source.sessionId &&
          item.runId === source.runId &&
          item.eventId === source.eventId &&
          item.eventSeq === source.eventSeq,
      ),
  );
  const isUnchanged =
    current.content === change.content.trim().replaceAll(/\s+/g, " ") &&
    (previous?.applicability ?? null) === change.applicability &&
    (previous?.evidenceStatus ?? MemoryEvidenceStatus.UNVERIFIED) === change.evidenceStatus &&
    !hasNewSource;
  return current.revision + (isUnchanged ? 0 : 1);
}
