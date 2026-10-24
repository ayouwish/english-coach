/**
 * "整句没听到"的判定（task-14 D）。
 *
 * 背景：真实用户遇到过 `recognized_text = "."` + `low_snr` 的 0 分结果 —— 那条 0 分不是读错，
 * 而是麦克风没拾到语音。这种情况**不能**展示"每词 0 分"的热力图（会让人以为是自己读错了），
 * 而要给出明确提示 + 醒目的重录入口。
 *
 * 判定口径（保守：只在"基本确定没听到"时才为真）：
 *   1) recognized_text 去掉标点/空白后长度 ≤ 1（例如 "." / "" / "…"）；或
 *   2) voice 显式给了 `low_snr` 警告。
 * 注意 `asr_mismatch` 单独出现**不算**没听到（那是"读的内容和参考句不一致"）。
 *
 * 纯函数、无依赖：服务端页面 / 客户端组件 / 自测脚本共用。
 */

export interface SpeechInput {
  recognized_text?: string | null;
  warnings?: string[] | null;
  words?: { word?: string | null; score?: number | null }[] | null;
}

/** 去掉标点、数字、空白后剩下的"字母"长度（用于判断是否有实际语音内容） */
export function spokenCharCount(text: string | null | undefined): number {
  if (!text) return 0;
  const stripped = text.replace(/[^\p{L}]/gu, "");
  return stripped.length;
}

export function isSpeechMissing(input: SpeechInput | null | undefined): boolean {
  if (!input) return false;
  const warnings = input.warnings ?? [];
  if (warnings.includes("low_snr")) return true;
  if (spokenCharCount(input.recognized_text) <= 1) return true;
  return false;
}

export const NO_SPEECH_TITLE = "这次好像没听到你的声音";
export const NO_SPEECH_HINT = "离麦克风近一点、说大声一点，再试一次。";
