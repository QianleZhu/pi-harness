import { type MemoryRecord, MemoryScope, MemorySourceType } from "../contract.js";
import {
  PROVISIONAL_MEMORY_CONTEXT_BUDGET,
  type ProvisionalMemory,
  RECORDED_MEMORY_CONTEXT_HEADING,
} from "../dreaming.js";

const PROVISIONAL_SEARCH_PREFIX = "[本会话未验证暂存] ";

function formatProvisionalBullet(item: ProvisionalMemory): string {
  const applicability = item.applicability ? `（适用条件：${item.applicability}）` : "";
  return `- ${item.content}${applicability}`;
}

function buildOverflowNotice(overflowCount: number): string {
  return `（另有 ${overflowCount} 条较早的本会话待整理记忆未展示，可使用 search_memories 检索）`;
}

// 将本 Session 的待审暂存记忆按最新优先在独立预算内拼装成纯内存上下文，超出部分归入 overflow 供降级检索。
export function formatProvisionalMemoriesContext(
  items: readonly ProvisionalMemory[],
  budget = PROVISIONAL_MEMORY_CONTEXT_BUDGET,
): { text: string | null; overflow: readonly ProvisionalMemory[] } {
  if (!items.length) return { text: null, overflow: [] };

  const selected: ProvisionalMemory[] = [];
  let selectedCount = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const candidate = [item, ...selected];
    const remaining = items.length - candidate.length;
    const rendered = renderProvisionalSection(candidate, remaining);
    if (rendered.length <= budget) {
      selected.unshift(item);
      selectedCount = selected.length;
    } else {
      break;
    }
  }

  if (selectedCount === 0) {
    return { text: null, overflow: items };
  }

  const overflow = items.slice(0, items.length - selectedCount);
  return {
    text: renderProvisionalSection(selected, overflow.length),
    overflow,
  };
}

function renderProvisionalSection(
  selected: readonly ProvisionalMemory[],
  overflowCount: number,
): string {
  const lines = [RECORDED_MEMORY_CONTEXT_HEADING, "", ...selected.map(formatProvisionalBullet)];
  if (overflowCount > 0) {
    lines.push("", buildOverflowNotice(overflowCount));
  }
  return lines.join("\n");
}

// 方案 A：仅对超出内存上下文预算的本会话暂存记忆做轻量关键词匹配，不构建向量索引。
export function searchOverflowProvisionalMemories(
  query: string,
  items: readonly ProvisionalMemory[],
  limit: number,
): readonly MemoryRecord[] {
  if (!items.length || limit <= 0) return [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const terms = normalizedQuery
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const scored: { item: ProvisionalMemory; score: number }[] = [];
  for (const item of items) {
    const haystack = `${item.content} ${item.applicability ?? ""}`.toLocaleLowerCase();
    let score = 0;
    if (haystack.includes(normalizedQuery)) {
      score += 10;
    }
    for (const term of terms) {
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ item, score });
  }

  return scored
    .sort((left, right) => right.score - left.score || right.item.createdAt - left.item.createdAt)
    .slice(0, limit)
    .map(({ item }) => {
      const content = `${PROVISIONAL_SEARCH_PREFIX}${item.content}`.slice(0, 500);
      return {
        id: item.id,
        content,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        revision: 1,
        scope: MemoryScope.WORKSPACE,
        sourceSessionId: item.sessionId,
        sourceType: MemorySourceType.SESSION,
        workspaceId: item.workspaceId,
      };
    });
}
