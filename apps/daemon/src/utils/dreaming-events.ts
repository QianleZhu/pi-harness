import { type HarnessEvent, HarnessEventType } from "@pi-harness/agent-runtime";
import { isPlainObject } from "es-toolkit";

// 去除图片等非文本内容，仅保留可分析的文本及工具参数。
export function textData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textData).filter((item) => item !== undefined);
  if (!isPlainObject(value)) return value;
  if (value.type === "image" || value.type === "image_url") return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const projected = textData(item);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

// 选择指定 Run 的文本事件，排除运行时系统提示和工具定义。
export function selectRunEvents(events: readonly HarnessEvent[], runId: string): HarnessEvent[] {
  const types = new Set<string>([
    HarnessEventType.MESSAGE_COMPLETED,
    HarnessEventType.TOOL_STARTED,
    HarnessEventType.TOOL_COMPLETED,
    HarnessEventType.TOOL_FAILED,
    HarnessEventType.RUN_COMPLETED,
    HarnessEventType.RUN_FAILED,
    HarnessEventType.RUN_ABORTED,
  ]);
  const selected = events.filter((event) => event.runId === runId && types.has(event.type));
  const started = events.filter(
    (event) => event.runId === runId && event.type === HarnessEventType.RUN_STARTED,
  );
  const terminal = selected.filter((event) =>
    [
      HarnessEventType.RUN_COMPLETED,
      HarnessEventType.RUN_FAILED,
      HarnessEventType.RUN_ABORTED,
    ].some((type) => type === event.type),
  );
  const start = started[0];
  const end = terminal[0];
  if (started.length !== 1 || terminal.length !== 1 || !start || !end || end.seq <= start.seq) {
    throw new Error("Dreaming run must have one start and one terminal event");
  }
  return selected.filter((event) => event.seq >= start.seq && event.seq <= end.seq);
}
