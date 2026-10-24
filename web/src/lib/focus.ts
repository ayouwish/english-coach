/**
 * 强化练习的焦点解析。
 *
 * 成人用 IPA（`/practice?focus=θ`）；儿童链接里**不能出现 IPA**，
 * 所以儿童用 `childLabel` 作为 token（`/practice?focus=咬舌尖的音`），服务端都能解析回规范符号。
 */
import { ARTICULATIONS, getArticulation, type Articulation } from "./articulation";

export interface FocusInfo {
  /** 规范音素符号；儿童请求在页面 payload 里不应出现，只用于服务端过滤 */
  ipa: string | null;
  /** 展示用文案：成人=ipa，儿童=childLabel */
  label: string | null;
  articulation: Articulation | null;
}

const norm = (x: string) => x.replace(/\s+/g, "").toLowerCase();

export function resolveFocus(raw: string | null | undefined): FocusInfo {
  const s = (raw ?? "").trim();
  if (!s) return { ipa: null, label: null, articulation: null };

  const direct = getArticulation(s);
  if (direct) return { ipa: direct.ipa, label: direct.ipa, articulation: direct };

  // 儿童 token：childLabel
  const hit = Object.values(ARTICULATIONS).find((a) => norm(a.childLabel) === norm(s));
  if (hit) return { ipa: hit.ipa, label: hit.childLabel, articulation: hit };

  // 也允许直接传含 IPA 的完整写法（例如带斜杠）
  const stripped = s.replace(/^\/|\/$/g, "");
  const bySlash = getArticulation(stripped);
  if (bySlash) return { ipa: bySlash.ipa, label: bySlash.ipa, articulation: bySlash };

  return { ipa: null, label: null, articulation: null };
}

/** 判断一句语料的 focus_phonemes 是否包含某音素 */
export function sentenceHasPhoneme(focusPhonemes: string[], ipa: string): boolean {
  return focusPhonemes.includes(ipa);
}

/** 最小对立对优先（tags 里带 minimal-pair / minpair / 具体对立名如 th-s 都算） */
export function isMinimalPairSentence(tags: string[]): boolean {
  return tags.some((t) => /minimal[-_]?pair|minpair/i.test(t) || /^[a-zɡθðʃʒŋtʃdʒ]+-[a-zɡθðʃʒŋtʃdʒ]+$/i.test(t));
}
