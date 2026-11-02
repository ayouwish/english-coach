/**
 * 单词音标查询（task-87）：代理 voice `/v1/words/ipa` + **进程内 LRU 缓存**（500 条）。
 *
 * - 未收录（voice 404）→ `{word, ipa:null}`（前端显示「暂无音标」，不报错）
 * - 非法单词 → throw WordIpaValidationError（路由转 400）
 * - voice 不可达 → throw VoiceError（路由转 503 可读）
 */
import { callWordIpa, VoiceError, type WordIpaResult } from "./voice";

const MAX_WORD_LEN = 40;
const CACHE_MAX = 500;
const cache = new Map<string, WordIpaResult>();

export class WordIpaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordIpaValidationError";
  }
}

/** 只接受英文字母/连字符/撇号（保留 "don't"、"well-known" 这类） */
export function normalizeWord(raw: unknown): string {
  const w = typeof raw === "string" ? raw.trim() : "";
  if (!w) throw new WordIpaValidationError("缺少单词");
  if (w.length > MAX_WORD_LEN) throw new WordIpaValidationError("单词太长");
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(w)) throw new WordIpaValidationError("只支持英文单词");
  return w;
}

function cacheGet(key: string): WordIpaResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    // LRU：命中后移到队尾
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: WordIpaResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** 查一个单词的音标（带缓存）；返回 ipa 可能为 null（未收录） */
export async function lookupWordIpa(raw: unknown): Promise<WordIpaResult> {
  const word = normalizeWord(raw);
  const key = word.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  const result = await callWordIpa(word);
  const normalized: WordIpaResult = { word, ipa: result.ipa ?? null, variants: result.variants ?? [], source: result.source ?? null, syllables: result.syllables ?? null };
  cacheSet(key, normalized);
  return normalized;
}

/** 仅供测试/排障：缓存大小 */
export function wordIpaCacheSize(): number {
  return cache.size;
}

export { VoiceError };
