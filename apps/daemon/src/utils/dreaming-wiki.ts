import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DREAMING_WIKI_NAME_PATTERN,
  type DreamingMemoryChange,
  RECORDED_MEMORY_CONTEXT_HEADING,
  resolveDreamingRevision,
} from "@pi-harness/memory";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMPTY_WIKI_INDEX = "# 索引\n\n暂无主题。\n";
export const DEFAULT_MEMORY_CONTEXT = "# 注入上下文\n\n导航：[索引](index.md)\n";
const REFERENCE_PATTERN = /\[memory:([0-9a-f-]{36})@(\d+)\]/gi;
// Wiki 内部文档链接使用与读取工具相同的单层文件名。
const WIKI_LINK_PATTERN = /\[[^\]\n]+\]\(([^\s)]+)\)/g;

// 清理数据库没有引用的 Wiki 目录，已发布目录保持可读。
export async function cleanupDreamingDirectories(
  root: string,
  dreaming: SqliteDreamingRepository,
): Promise<void> {
  const base = resolve(root, "dreaming");
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(base, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || !ID_PATTERN.test(workspace.name)) continue;
    const workspacePath = join(base, workspace.name);
    for (const directory of await readdir(workspacePath, { withFileTypes: true })) {
      if (
        !directory.isDirectory() ||
        !ID_PATTERN.test(directory.name) ||
        dreaming.hasWikiVersion(workspace.name, directory.name)
      )
        continue;
      const target = resolve(workspacePath, directory.name);
      if (target !== join(workspacePath, directory.name))
        throw new Error("Invalid Dreaming directory");
      await rm(target, { recursive: true, force: true });
    }
  }
}

// 读取当前发布的 Wiki，整理时在内存中维护完整草案；注入上下文已独立存储。
export async function readWiki(directory: string | null): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!directory) return files;
  for (const name of await readdir(directory)) {
    if (!DREAMING_WIKI_NAME_PATTERN.test(name) || name === "context.md") continue;
    files.set(name, await readFile(join(directory, name), "utf8"));
  }
  return files;
}

// 注入上下文与 Wiki 分开存储，每个版本使用独立目录保存 context.md。
export function contextDirectory(root: string, workspaceId: string, directoryId: string): string {
  if (!ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(directoryId))
    throw new Error("Invalid Dreaming context directory");
  return join(root, "dreaming", workspaceId, "contexts", directoryId);
}

// 读取上下文版本；目录缺失时返回 null。
export async function readContextFile(directory: string): Promise<string | null> {
  try {
    return await readFile(join(directory, "context.md"), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

// 清理数据库没有引用的上下文目录，已发布版本保持可读。
export async function cleanupDreamingContextDirectories(
  root: string,
  dreaming: SqliteDreamingRepository,
): Promise<void> {
  const base = resolve(root, "dreaming");
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(base, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || !ID_PATTERN.test(workspace.name)) continue;
    const contextsPath = join(base, workspace.name, "contexts");
    let contexts: Dirent[];
    try {
      contexts = await readdir(contextsPath, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const context of contexts) {
      if (
        !context.isDirectory() ||
        !ID_PATTERN.test(context.name) ||
        dreaming.hasContextVersion(workspace.name, context.name)
      )
        continue;
      const target = resolve(contextsPath, context.name);
      if (target !== join(contextsPath, context.name))
        throw new Error("Invalid Dreaming context directory");
      await rm(target, { recursive: true, force: true });
    }
  }
}

// 移除第一层临时区块，保留其前后的正式上下文。
export function stripRecordedMemorySection(context: string): string {
  const newline = context.includes("\r\n") ? "\r\n" : "\n";
  const lines = context.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === RECORDED_MEMORY_CONTEXT_HEADING);
  if (headingIndex < 0) return context;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const joined = [...lines.slice(0, headingIndex), ...lines.slice(end)].join(newline);
  const collapsed =
    newline === "\r\n"
      ? joined.replaceAll(/(\r\n){3,}/g, "\r\n\r\n")
      : joined.replaceAll(/\n{3,}/g, "\n\n");
  return `${collapsed.trimEnd()}${newline}`;
}

// 校验独立的注入上下文预算、导航和临时区块。
export function validateContext(
  context: string,
  files: Map<string, string>,
): void {
  if (context.length > 2000) throw new Error("Dreaming context exceeds budget");
  if (context.includes(RECORDED_MEMORY_CONTEXT_HEADING))
    throw new Error("Dreaming context must not include provisional recorded memories");
  if (!context.includes("index.md") || !files.has("index.md"))
    throw new Error("Dreaming context must point to navigation");
}

// 校验完整 Wiki 的预算和摘要引用；注入上下文由 validateContext 单独校验。
export function validateWiki(
  files: Map<string, string>,
  changes: DreamingMemoryChange[],
  memories: SqliteMemoryRepository,
  dreaming: SqliteDreamingRepository,
  workspaceId: string,
) {
  const index = files.get("index.md");
  if (index === undefined || index.length > 4000)
    throw new Error("Invalid Wiki navigation");
  let topicsLength = 0;
  const refs = new Map<string, { memoryId: string; revision: number; isCurrent: boolean }>();
  for (const [name, text] of files) {
    if (!DREAMING_WIKI_NAME_PATTERN.test(name) || name === "context.md")
      throw new Error("Invalid Wiki filename");
    // 仅校验正文链接；代码示例中的链接文本不代表 Wiki 导航。
    const prose = text
      .replaceAll(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[ \t]*$/gm, "")
      .replaceAll(/`+[^`\n]*`+/g, "");
    for (const link of prose.matchAll(WIKI_LINK_PATTERN)) {
      const target = link[1]?.split("#", 1)[0];
      if (!target || !/\.md$/i.test(target) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target))
        continue;
      const targetName = target.startsWith("./") ? target.slice(2) : target;
      if (!DREAMING_WIKI_NAME_PATTERN.test(targetName) || !files.has(targetName))
        throw new Error("Wiki linked document not found");
    }
    if (name !== "context.md" && name !== "index.md") {
      topicsLength += text.length;
      if (!index.includes(name) || !text.match(REFERENCE_PATTERN))
        throw new Error("Wiki topic must be navigable and cite memory");
    }
    for (const raw of text.matchAll(/\[memory:[^\]]*\]/gi)) {
      if (!/^\[memory:[0-9a-f-]{36}@\d+\]$/i.test(raw[0]))
        throw new Error("Invalid Wiki reference");
    }
    for (const match of text.matchAll(REFERENCE_PATTERN)) {
      const memoryId = match[1];
      const revision = Number(match[2]);
      if (
        !memoryId ||
        !ID_PATTERN.test(memoryId) ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new Error("Invalid Wiki reference");
      const change = changes.find((item) => item.memoryId === memoryId);
      if (change) {
        const current = change.expectedRevision === null ? null : memories.find(memoryId);
        const prior = current ? dreaming.findRevision(memoryId, current.revision) : null;
        const priorSources = current ? dreaming.listSources(memoryId, current.revision) : [];
        const next = resolveDreamingRevision(change, current, prior, priorSources);
        if (revision === next) continue;
      }
      const memory = memories.find(memoryId);
      if (!memory || memory.workspaceId !== workspaceId)
        throw new Error("Wiki references unknown memory");
      refs.set(`${memoryId}@${revision}`, {
        memoryId,
        revision,
        isCurrent: memory.revision === revision,
      });
    }
  }
  if (topicsLength > 40000) throw new Error("Wiki exceeds budget");
  return [...refs.values()];
}
