import { DatabaseSync } from "node:sqlite";
import { isPlainObject } from "es-toolkit";
import type { ToolRegistration } from "../lib/tool-registry.js";
import {
  buildFtsMatchQuery,
  FTS5_UNICODE61_TOKENIZER,
  formatFtsIndexText,
  normalizeSearchText,
} from "./fts-search.js";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const MAX_TOOL_SEARCH_RESULTS = 10;
export const MAX_VISIBLE_TOOLS = 64;

export interface ToolSearchMatch {
  description: string;
  label: string;
  name: string;
  source: string;
}

interface IndexedToolCandidate {
  descriptionTokens: string;
  exact: boolean;
  match: ToolSearchMatch;
  nameTokens: string;
  parameterTokens: string;
}

function parameterSearchText(parameters: unknown): string {
  const pending: unknown[] = [parameters];
  const visited = new Set<object>();
  const text: string[] = [];
  while (pending.length > 0) {
    const schema = pending.pop();
    if (!isPlainObject(schema) || visited.has(schema)) continue;
    visited.add(schema);
    if (typeof schema.description === "string") text.push(schema.description);
    if (isPlainObject(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        text.push(name);
        pending.push(property);
      }
    }
    if (isPlainObject(schema.items)) pending.push(schema.items);
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(schema[keyword])) pending.push(...schema[keyword]);
    }
  }
  return text.join(" ");
}

function buildCandidates(
  registrations: readonly ToolRegistration[],
  normalizedQuery: string,
): IndexedToolCandidate[] {
  return registrations.map(({ searchDescription, source, tool }) => {
    const description = searchDescription ?? tool.description;
    const parameters = parameterSearchText(tool.parameters);
    const match: ToolSearchMatch = {
      description: description.slice(0, 160),
      label: tool.label,
      name: tool.name,
      source: source.startsWith("mcp:") ? "mcp" : source,
    };
    return {
      // 普通索引使用上游名称，模型别名中的服务器散列只参与完整名称匹配。
      descriptionTokens: formatFtsIndexText(description.slice(0, 900)),
      exact:
        normalizeSearchText(tool.name) === normalizedQuery ||
        normalizeSearchText(tool.label.split(" / ").at(-1) ?? tool.label) === normalizedQuery,
      match,
      nameTokens: formatFtsIndexText(tool.label),
      parameterTokens: formatFtsIndexText(parameters.slice(0, 900)),
    };
  });
}

/** 检索只处理候选摘要；使用应用层预分词 + 内存 FTS5 unicode61 BM25 排序，完整名称精确命中优先。 */
export function searchToolRegistrations(
  registrations: readonly ToolRegistration[],
  query: string,
  limit = MAX_TOOL_SEARCH_RESULTS,
): ToolSearchMatch[] {
  const phrase = query.trim();
  const cappedLimit = Math.min(limit, MAX_TOOL_SEARCH_RESULTS);
  if (!phrase || cappedLimit <= 0 || registrations.length === 0) return [];

  const normalizedQuery = normalizeSearchText(phrase);
  const candidates = buildCandidates(registrations, normalizedQuery);
  const exactMatches = candidates
    .filter(({ exact }) => exact)
    .sort((left, right) => left.match.name.localeCompare(right.match.name))
    .map(({ match }) => match);

  const expression = buildFtsMatchQuery(phrase);
  if (expression === null) return exactMatches.slice(0, cappedLimit);

  const byName = new Map(candidates.map((candidate) => [candidate.match.name, candidate.match]));
  const index = new DatabaseSync(":memory:");
  try {
    index.exec(
      `CREATE VIRTUAL TABLE tool_search USING fts5(
        tool_name UNINDEXED,
        name_tokens,
        description_tokens,
        parameter_tokens,
        tokenize='${FTS5_UNICODE61_TOKENIZER}'
      )`,
    );
    const insert = index.prepare(
      `INSERT INTO tool_search (tool_name, name_tokens, description_tokens, parameter_tokens)
       VALUES (?, ?, ?, ?)`,
    );
    for (const candidate of candidates) {
      insert.run(
        candidate.match.name,
        candidate.nameTokens,
        candidate.descriptionTokens,
        candidate.parameterTokens,
      );
    }
    const rows = index
      .prepare(
        `SELECT tool_name
         FROM tool_search
         WHERE tool_search MATCH ?
         ORDER BY bm25(tool_search, 0.0, 5.0, 2.0, 1.0), tool_name
         LIMIT ?`,
      )
      .all(expression, MAX_TOOL_SEARCH_RESULTS);

    const results: ToolSearchMatch[] = [...exactMatches];
    const seen = new Set(results.map(({ name }) => name));
    for (const row of rows) {
      const name = String(row.tool_name);
      if (seen.has(name)) continue;
      const match = byName.get(name);
      if (!match) continue;
      seen.add(name);
      results.push(match);
      if (results.length >= cappedLimit) break;
    }
    return results.slice(0, cappedLimit);
  } finally {
    index.close();
  }
}

export function loadToolRegistrations(
  registrations: readonly ToolRegistration[],
  names: readonly string[],
  visibleNames: Set<string>,
): string[] {
  if (
    names.length < 1 ||
    names.length > MAX_TOOL_SEARCH_RESULTS ||
    new Set(names).size !== names.length
  )
    throw new Error("TOOL_LOAD_INVALID: 单次请选择 1 到 10 个不同的工具");
  const available = new Set(
    registrations.filter(({ source }) => source.startsWith("mcp:")).map(({ tool }) => tool.name),
  );
  for (const name of names) {
    if (!available.has(name))
      throw new Error(`TOOL_LOAD_NOT_FOUND: 工具 ${name} 不在本轮 MCP 目录中`);
  }
  const newNames = names.filter((name) => !visibleNames.has(name));
  if (visibleNames.size + newNames.length > MAX_VISIBLE_TOOLS)
    throw new Error("TOOL_LOAD_LIMIT_EXCEEDED: 当前 Run 的工具数量已达上限");
  for (const name of newNames) visibleNames.add(name);
  return newNames;
}
