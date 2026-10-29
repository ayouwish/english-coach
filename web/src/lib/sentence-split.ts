/**
 * 把一段文本按句末标点切成句子（连读模式与"书页材料"共用）。
 * 过滤空句/纯标点；保留句末标点。
 */
export function splitSentences(raw: string): string[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (/[.!?。！？]/.test(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.replace(/[^\p{L}\p{N}]/gu, "").length > 0);
}

/** 句数（用于 materials.sentence_count，服务端重算） */
export function countSentences(text: string): number {
  return splitSentences(text).length;
}
