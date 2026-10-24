/**
 * 音素（canonical-v1）→ 口型/舌位提示键的映射。
 *
 * 单一事实来源是 `phoneme-hints.json`（数据），TS 与 `scripts/check-phoneme-hints.mjs` 共用同一份，
 * 避免"表里少一个键、静默退化成无提示"这类问题再次靠人肉发现。
 *
 * 背景：语料与 voice 输出统一到 canonical-v1（`voice/app/phonemes.py`），
 * 旧符号 `iː→i uː→u ɒ→ɑ ɹ→r ɛ→e ɝ→ɜ ɚ→ə` 等已被折叠 —— 所以映射表只能用规范符号。
 * 变更规范符号集时：先改 JSON，再跑 `pnpm check:phoneme-hints`（会与 voice 的 CANONICAL_PHONEMES 交叉核对）。
 */
import data from "./phoneme-hints.json";

export const PHONEME_SPACE_ID: string = data.spaceId;

/** canonical-v1 的 43 个规范符号（顺序与 voice/app/phonemes.py 一致，便于逐行核对） */
export const CANONICAL_PHONEMES: readonly string[] = data.canonical;

/** 有专属/最小对立提示的符号 → hint 键 */
export const PHONEME_HINT_MAP: Readonly<Record<string, string>> = data.map;

/** 有意为空的符号 → 理由（不是漏掉；脚本会强制要求"每个规范符号恰好归入一侧"） */
export const INTENTIONALLY_UNMAPPED: Readonly<Record<string, string>> = data.intentionallyUnmapped;

/** 近似映射的说明（语义不完全等价，但现有 hint 键里最贴切） */
export const APPROXIMATE_MAPPINGS: Readonly<Record<string, string>> = data.approximations;

/**
 * 音素 → hint 键；没有贴切提示时返回空串（调用方会退化成 GENERIC 通用文案）。
 * 注意：**返回值只可能是合法的 hint 键或空串**，绝不会回退成音素符号本身
 * （回退成符号会把 IPA 带进儿童页面的 RSC 负载）。
 */
export function hintKeyForPhoneme(phoneme: string): string {
  return PHONEME_HINT_MAP[phoneme] ?? "";
}
