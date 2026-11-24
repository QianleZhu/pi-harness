import type { MemoryRecord } from "../contract.js";

export interface GlobalMemoryDiffAdded {
  id: string;
  content: string;
  revision: number;
}

export interface GlobalMemoryDiffUpdated {
  id: string;
  beforeContent: string;
  afterContent: string;
  beforeRevision: number;
  afterRevision: number;
}

export interface GlobalMemoryDiffDeleted {
  id: string;
  beforeContent: string;
}

export interface GlobalMemoryDiff {
  added: readonly GlobalMemoryDiffAdded[];
  updated: readonly GlobalMemoryDiffUpdated[];
  deleted: readonly GlobalMemoryDiffDeleted[];
}

// 对比两个全局记忆发布快照，生成用户在整理期间执行的新增、修改和删除差量。
export function diffGlobalMemories(
  base: readonly MemoryRecord[],
  latest: readonly MemoryRecord[],
): GlobalMemoryDiff {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const latestById = new Map(latest.map((item) => [item.id, item]));

  const added: GlobalMemoryDiffAdded[] = [];
  const updated: GlobalMemoryDiffUpdated[] = [];
  const deleted: GlobalMemoryDiffDeleted[] = [];

  for (const current of latest) {
    const prior = baseById.get(current.id);
    if (!prior) {
      added.push({
        id: current.id,
        content: current.content,
        revision: current.revision,
      });
    } else if (prior.revision !== current.revision || prior.content !== current.content) {
      updated.push({
        id: current.id,
        beforeContent: prior.content,
        afterContent: current.content,
        beforeRevision: prior.revision,
        afterRevision: current.revision,
      });
    }
  }

  for (const prior of base) {
    if (!latestById.has(prior.id)) {
      deleted.push({
        id: prior.id,
        beforeContent: prior.content,
      });
    }
  }

  return { added, updated, deleted };
}
