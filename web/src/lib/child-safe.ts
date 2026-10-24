/**
 * 儿童可见载荷的 IPA 安全网（task-11）。
 *
 * 设计原则：**不做逐字段打补丁**。历史教训是 IPA 会从任何没被检查的序列化路径漏出去
 * （`srs_cards.id` → `hint_key` → `demo_text`），所以这里提供两层：
 *   1) 运行时兜底：`childSafeDeep()` 递归剥离整个响应对象里的 IPA 字形（新增字段自动被覆盖，并打日志）；
 *   2) 测试守卫：`scripts/check-child-ipa.mjs` 把儿童响应/页面**整体序列化后扫描**全部特征字形。
 *
 * 字形集合在 `child-safe.json`（单一数据源，TS 与脚本共用）。
 */
import glyphData from "./child-safe.json";

/** 必须为空的 18 个特征字形（契约/验收口径） */
export const CHARACTERISTIC_IPA_GLYPHS: readonly string[] = glyphData.glyphs;

function classEscape(ch: string): string {
  return ch.replace(/[\\\]^/-]/g, "\\$&");
}

const REQUIRED_CLASS = CHARACTERISTIC_IPA_GLYPHS.map(classEscape).join("");

/**
 * 兜底剥离用的更宽集合：特征字形 + voice 会折叠掉的旧变体 + 长音符。
 * （旧变体理论上不会出现在 canonical-v1 输出里，但"兜底"就应该比"必须为空"更宽。）
 */
const EXTRA_STRIP = ["ɐ", "ɚ", "ɝ", "ɻ", "ɾ", "ʉ", "ɨ", "ɵ", "ɘ", "ᵻ", "ʤ", "ʧ", "ː", "ɡ"]
  .map(classEscape)
  .join("");

const REQUIRED_IPA = new RegExp(`[${REQUIRED_CLASS}]`, "g");
const STRIP_IPA = new RegExp(`[${REQUIRED_CLASS}${EXTRA_STRIP}]`, "g");
const SLASH_NOTATION = /\/\s*[^/\s]{1,6}\s*\//g;

/** 只剥离 IPA 字形（不改动斜杠记法/空白）——用于 API 载荷兜底，避免误伤英文原文 */
export function stripIpaGlyphs(text: string): string {
  return text.replace(STRIP_IPA, "");
}

/** 教学文案用：剥离 IPA 字形 + 把 `/x/` 记法替换成「这个音」 */
export function childSafeText(text: string): string {
  return text
    .replace(SLASH_NOTATION, "这个音")
    .replace(STRIP_IPA, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 在任意值里找特征字形（用于自测断言；返回命中的字形集合） */
export function findIpaLeaks(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const hits = new Set<string>();
  for (const m of text.matchAll(REQUIRED_IPA)) hits.add(m[0]);
  return [...hits];
}

/**
 * 递归兜底：把对象/数组里所有字符串的 IPA 字形剥掉，并记录被改动的路径。
 * 返回新对象（不改原对象），保证调用方拿到的永远是"可安全下发"的副本。
 */
export function childSafeDeep<T>(value: T, label = "payload"): T {
  const touched: string[] = [];

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      const cleaned = stripIpaGlyphs(node);
      if (cleaned !== node) touched.push(path);
      return cleaned;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, `${path}.${k}`);
      }
      return out;
    }
    return node;
  };

  const result = walk(value, label) as T;
  if (touched.length > 0) {
    // 这是"本该在源头就为空"的信号：留日志，便于下次直接从源头修，而不是靠兜底
    console.warn(
      `[child-safe] ${label} 兜底剥离了 IPA 字形（请修源头）：${[...new Set(touched)].slice(0, 8).join(", ")}` +
        (touched.length > 8 ? ` …共 ${touched.length} 处` : ""),
    );
  }
  return result;
}
