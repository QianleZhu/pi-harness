import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DREAMING_WIKI_NAME_PATTERN,
  type DreamingMemoryChange,
  resolveDreamingRevision,
} from "@pi-harness/memory";
import type { SqliteDreamingRepository } from "../storage/dreaming-repository.js";
import type { SqliteMemoryRepository } from "../storage/memory-repository.js";

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

// 读取当前发布的 Wiki，整理时在内存中维护完整草案。
export async function readWiki(directory: string | null): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!directory) return files;
  for (const name of await readdir(directory)) {
    if (!DREAMING_WIKI_NAME_PATTERN.test(name)) throw new Error("Invalid Wiki filename");
    files.set(name, await readFile(join(directory, name), "utf8"));
  }
  return files;
}

// 校验完整 Wiki 的预算和摘要引用。
export function validateWiki(
  files: Map<string, string>,
  changes: DreamingMemoryChange[],
  memories: SqliteMemoryRepository,
  dreaming: SqliteDreamingRepository,
  workspaceId: string,
) {
  const context = files.get("context.md");
  const index = files.get("index.md");
  if (context === undefined || index === undefined || context.length > 2000 || index.length > 4000)
    throw new Error("Invalid Wiki navigation or context");
  if (!context.includes("index.md")) throw new Error("Wiki context must point to navigation");
  let topicsLength = 0;
  const refs = new Map<string, { memoryId: string; revision: number; isCurrent: boolean }>();
  for (const [name, text] of files) {
    if (!DREAMING_WIKI_NAME_PATTERN.test(name)) throw new Error("Invalid Wiki filename");
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
