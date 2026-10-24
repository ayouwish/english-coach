#!/usr/bin/env node
/**
 * canonical-v1 音素 → hint 键映射的**可复跑断言**（task-10）。
 *
 * 它回答的问题是："归一化之后，会不会有某个规范音素**静默地**拿不到提示？"
 * 做法：
 *   1) 从 voice/app/phonemes.py 读 CANONICAL_PHONEMES（只读，不修改 voice/），与本仓库 JSON 交叉核对；
 *   2) 遍历全部规范符号，打印各自的 hintKeyForPhoneme() 结果；
 *   3) 硬性断言：
 *      - 每个规范符号**恰好**归入 map 或 intentionallyUnmapped 之一（都没有 = 漏键，直接失败）；
 *      - map/unmapped 的键必须都是规范符号（出现 iː/uː/ɹ/ɛ/ɒ 这类旧符号 = 死键，失败）；
 *      - 所有 hint 键必须是契约 §3.1 冻结的合法取值（防止有人发明不存在的键）；
 *      - hintKeyForPhoneme() 的返回值永远不是音素符号本身（否则 IPA 会漏进儿童页面）。
 *
 * 用法：node scripts/check-phoneme-hints.mjs   （或 pnpm check:phoneme-hints）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 可用 PHONEME_HINTS_JSON 指向别的映射文件（自测"漏键/死键会不会被抓到"时用）
const MAP_JSON = process.env.PHONEME_HINTS_JSON
  ? path.resolve(process.env.PHONEME_HINTS_JSON)
  : path.join(WEB_ROOT, "src/lib/phoneme-hints.json");
const VOICE_PHONEMES = path.resolve(WEB_ROOT, "..", "voice", "app", "phonemes.py");

// 契约 §3.1 冻结的 hint_key 合法取值（与 src/lib/hints.ts 的 HINTS 键一致）
const VALID_HINT_KEYS = new Set([
  "th_voiceless", "th_voiced", "r_l_v", "v_w", "short_i_long_i", "ae_e", "s_sh", "n_ng",
  "l_dark", "schwa", "final_consonant", "consonant_cluster", "stress_wrong", "monotone",
  "pause_wrong", "omission", "insertion",
]);

const data = JSON.parse(fs.readFileSync(MAP_JSON, "utf8"));
const canonical = data.canonical;
const map = data.map;
const unmapped = data.intentionallyUnmapped;
const approximations = data.approximations ?? {};

let failed = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`=== canonical-v1 音素 → hint 键映射核对（space=${data.spaceId}）===\n`);

// ── 0) 与 voice 的规范集交叉核对（voice/ 只读）───────────────────────────────
let voiceCanonical = null;
if (fs.existsSync(VOICE_PHONEMES)) {
  const py = fs.readFileSync(VOICE_PHONEMES, "utf8");
  const block = /CANONICAL_PHONEMES[^=]*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(py);
  if (block) voiceCanonical = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(
    "从 voice/app/phonemes.py 解析出 CANONICAL_PHONEMES",
    Array.isArray(voiceCanonical) && voiceCanonical.length > 0,
    `n=${voiceCanonical?.length ?? 0}`,
  );
} else {
  console.log(`⚠️  未找到 ${VOICE_PHONEMES}（跳过交叉核对，只校验本仓库 JSON）`);
}

if (voiceCanonical) {
  const mine = new Set(canonical);
  const theirs = new Set(voiceCanonical);
  const missing = voiceCanonical.filter((p) => !mine.has(p));
  const extra = canonical.filter((p) => !theirs.has(p));
  check(
    "本仓库的规范集与 voice 完全一致（43 个）",
    missing.length === 0 && extra.length === 0 && canonical.length === voiceCanonical.length,
    `voice=${voiceCanonical.length} web=${canonical.length}` +
      (missing.length ? ` 缺:${missing.join("")}` : "") +
      (extra.length ? ` 多:${extra.join("")}` : ""),
  );
}
check("规范集数量为 43", canonical.length === 43, `n=${canonical.length}`);
check("规范集无重复符号", new Set(canonical).size === canonical.length);

// ── 1) 遍历打印：每个规范符号的 hintKeyForPhoneme() 结果 ──────────────────────
console.log("\n符号  hint_key            归类 / 说明");
console.log("────  ──────────────────  ────────────────────────────────────────────────");
const groups = {
  "辅音": canonical.slice(0, 24),
  "单元音": canonical.slice(24, 35),
  "双元音": canonical.slice(35, 40),
  "央化双元音": canonical.slice(40),
};
const accidentallyEmpty = [];
for (const [group, symbols] of Object.entries(groups)) {
  console.log(`\n【${group}】`);
  for (const p of symbols) {
    const hint = map[p] ?? "";
    const reason = unmapped[p];
    if (hint) {
      const approx = approximations[p] ? "（近似映射，见 JSON approximations）" : "";
      console.log(`${p.padEnd(6)}${hint.padEnd(20)}映射${approx}`);
    } else if (reason) {
      console.log(`${p.padEnd(6)}${"—".padEnd(20)}有意为空：${reason}`);
    } else {
      console.log(`${p.padEnd(6)}${"(空)".padEnd(20)}❌ 未分类（漏键！）`);
      accidentallyEmpty.push(p);
    }
  }
}

// ── 2) 硬性断言 ──────────────────────────────────────────────────────────────
console.log("");
check(
  "没有「意外返回空」的符号（每个空都必须有书面理由）",
  accidentallyEmpty.length === 0,
  accidentallyEmpty.length ? `未分类: ${accidentallyEmpty.join(" ")}` : `有意为空 ${Object.keys(unmapped).length} 个`,
);

const canonicalSet = new Set(canonical);
const mapKeys = Object.keys(map);
const unmappedKeys = Object.keys(unmapped);
const deadKeys = [...mapKeys, ...unmappedKeys].filter((k) => !canonicalSet.has(k));
check(
  "没有死键（旧符号 iː/uː/ɹ/ɛ/ɒ/ɝ/ɚ 等不得再出现）",
  deadKeys.length === 0,
  deadKeys.length ? `死键: ${deadKeys.join(" ")}` : `map=${mapKeys.length} unmapped=${unmappedKeys.length}`,
);

const bothSides = mapKeys.filter((k) => unmappedKeys.includes(k));
check("同一个符号不会既映射又声明为空", bothSides.length === 0, bothSides.join(" "));

const uncovered = canonical.filter((p) => !mapKeys.includes(p) && !unmappedKeys.includes(p));
check("每个规范符号都恰好归入 map 或 intentionallyUnmapped", uncovered.length === 0, uncovered.join(" "));

const badHintKeys = [...new Set(mapKeys.map((k) => map[k]))].filter((v) => !VALID_HINT_KEYS.has(v));
check(
  "映射值都是契约 §3.1 冻结的合法 hint 键（没有发明新键）",
  badHintKeys.length === 0,
  badHintKeys.length ? `非法: ${badHintKeys.join(" ")}` : `${new Set(mapKeys.map((k) => map[k])).size} 种键`,
);

const selfMapping = mapKeys.filter((k) => map[k] === k);
check("hint 键绝不会等于音素符号本身（IPA 不会经 hint_key 漏出）", selfMapping.length === 0, selfMapping.join(" "));

const badUnmappedReason = unmappedKeys.filter((k) => (unmapped[k] ?? "").trim().length < 4);
check("每个「有意为空」都写了可读理由", badUnmappedReason.length === 0, badUnmappedReason.join(" "));

const normalizedKeys = Object.keys(approximations).filter((k) => !canonicalSet.has(k) || !map[k]);
check("approximations 只标注已映射的规范符号", normalizedKeys.length === 0, normalizedKeys.join(" "));

console.log(
  `\n合计：规范符号 ${canonical.length} 个 → 有映射 ${mapKeys.length} 个、有意为空 ${unmappedKeys.length} 个；` +
    `其中近似映射 ${Object.keys(approximations).length} 个（已在 JSON 注明语义差异）。`,
);
console.log(failed === 0 ? "\n结论：全部通过 ✅（下次规范集新增符号时，本脚本会直接失败，不会静默退化）" : `\n结论：${failed} 项失败 ❌`);
process.exit(failed > 0 ? 1 : 0);
