export const FTS5_UNICODE61_TOKENIZER = "unicode61 remove_diacritics 2";

const MAX_QUERY_TERMS = 16;
const zhWordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

function normalizeEnglishToken(token: string): string {
  // 仅归一化常见英语复数，避免把 status、analysis 等单词截断。
  if (/^[a-z]+$/.test(token) && token.length > 3) {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (/(ches|shes|sses|xes|zes)$/.test(token)) return token.slice(0, -2);
    if (token.endsWith("s") && !/(ss|us|is|as)$/.test(token)) return token.slice(0, -1);
  }
  return token;
}

function flushHanSingles(singles: string[], output: string[]): void {
  if (singles.length === 0) return;
  if (singles.length === 1) {
    const single = singles[0];
    if (single !== undefined) output.push(single);
  } else {
    // 将被分词器切散的连续单字（如“缓存”被切为“缓”“存”）合并为二元词，避免单字噪声。
    for (let index = 0; index < singles.length - 1; index += 1) {
      output.push(`${singles[index]}${singles[index + 1]}`);
    }
  }
  singles.length = 0;
}

function appendHanTokens(chunk: string, output: string[]): void {
  const singles: string[] = [];
  for (const segment of zhWordSegmenter.segment(chunk)) {
    if (!segment.isWordLike) continue;
    const word = segment.segment.trim();
    if (!word) continue;
    const characters = Array.from(word);
    if (characters.length === 1) {
      singles.push(word);
      continue;
    }
    flushHanSingles(singles, output);
    output.push(word);
    // 对 3 字及以上的中文复合词补充二元切分，兼顾整词高权重与子词召回。
    if (characters.length >= 3) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        output.push(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  flushHanSingles(singles, output);
}

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLocaleLowerCase()
    .replace(/[_/-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenizeSearchText(text: string): string[] {
  const chunks =
    normalizeSearchText(text)
      .replace(/([\p{Script=Han}]+)/gu, " $1 ")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      appendHanTokens(chunk, tokens);
    } else {
      tokens.push(normalizeEnglishToken(chunk));
    }
  }
  return tokens;
}

export function formatFtsIndexText(text: string): string {
  return tokenizeSearchText(text).join(" ");
}

export function buildFtsMatchQuery(query: string, maxTerms = MAX_QUERY_TERMS): string | null {
  const terms = [...new Set(tokenizeSearchText(query))].slice(0, Math.max(1, maxTerms));
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
