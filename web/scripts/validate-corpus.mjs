#!/usr/bin/env node
/**
 * 跟读语料校验：node web/scripts/validate-corpus.mjs
 *
 * 校验 web/src/data/sentences.json：
 *   1. 恰好 600 条；id 唯一且符合 s-<level>-NN 命名；text 归一化后不重复
 *   2. 各级别条数：A1 100 / A2 200 / B1 200 / B2 100
 *   3. focus_phonemes 必须全部落在 canonical-v1 规范空间内（辅音 24 + 元音 19 = 43），每句 1–4 个
 *   4. 必填字段非空；text 长度 A1 ≤ 60 / A2 ≤ 90 / B1 ≤ 140 / B2 ≤ 180；tags 非空
 *   5. 音素覆盖报告：43 个规范音素各自的句子数，< 3 句记 warning；另报各级别词数分布
 *   6. 最小对立对分组统计（tags 含 minimal-pair + 分组 tag）
 *
 * 符号空间 = **canonical-v1**，定义处是 `voice/app/phonemes.py` 的 `CANONICAL_PHONEMES`
 * （下方常量从那里抄来；voice 会把任何 provider 的输出归一到这套符号，语料必须与它一致，
 * 否则同一发音错误会生成两张 SRS 卡片、phoneme_mastery 静默断链）。
 * 语料已不再使用 RP 写法：iː→i uː→u ɔː→ɔ ɜː→ɜ ɑː→ɑ ɒ→ɑ。
 * `ʊə / ɪə / eə` 仍在规范空间里（保留为 key，避免同一音分裂），但 **en-US 不存在这三个音**
 * （tour=ʊr、bear=er、near=ɪr），所以语料里已全部改写成句中真实存在的 ʊ / e / ɪ，
 * 它们不再被任何句子使用（见 RETIRED_IN_CORPUS，不计入 warning）。
 *
 * 退出码：0 = 全部硬性检查通过（warning 不影响退出码）；1 = 存在硬性错误。
 * 用法：node web/scripts/validate-corpus.mjs [--json]
 *
 * 生成方式（corpus 任务，不是本脚本职责）：sentences.json 由一次性 Node 生成器写出——
 * 基线是原 66 句（id s-<level>-01..22，仅清理 IPA 允许集合外的符号），再从人工撰写的候选池
 * 为每个 level 确定性挑选 78 条（先补齐 7 个最小对立对组，再按"补足覆盖不足音素"贪心）。
 * 生成器与候选池是临时文件，按写入范围要求已删除，因此当前 sentences.json 就是可手工编辑的
 * 事实来源。改完语料请同时跑本脚本与 tests/audit_corpus_phonemes.py——后者用 cmudict 校验
 * "标注的音素是否真的出现在句子里"，而本脚本只校验符号合法性（两者互补，缺一不可）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(HERE, "..", "src", "data", "sentences.json");

// canonical-v1 规范空间（逐字抄自 voice/app/phonemes.py 的 CANONICAL_PHONEMES，勿凭记忆改）
const CONSONANTS = "p b t d k ɡ f v θ ð s z ʃ ʒ h m n ŋ l r j w tʃ dʒ".split(" ");
const MONOPHTHONGS = "i ɪ e æ ʌ ə ɜ ɑ ɔ ʊ u".split(" ");
const DIPHTHONGS = "eɪ aɪ ɔɪ əʊ aʊ".split(" ");
// RP 央化双元音：仍在规范空间里（voice 保留它们作 key），但 en-US 无此音，语料已不再使用
const RETIRED_IN_CORPUS = "ʊə ɪə eə".split(" ");
const VOWELS = [...MONOPHTHONGS, ...DIPHTHONGS, ...RETIRED_IN_CORPUS];
const ALLOWED = [...CONSONANTS, ...VOWELS];
const ALLOWED_SET = new Set(ALLOWED);

const EXPECTED_TOTAL = 600;
// 各级别目标条数（task-48：A2/B1 各扩到 200，新增 B2 100，A1 保持 100）
const LEVEL_TARGET = { A1: 100, A2: 200, B1: 200, B2: 100 };
const LEVEL_RANGE = [90, 210];
const TEXT_LIMIT = { A1: 60, A2: 90, B1: 140, B2: 180 };
const MIN_PHONEME_SENTENCES = 3;
// 43 个规范符号 − 3 个 en-US 不存在的央化双元音 = 语料实际可覆盖的上限 40
const MIN_PHONEME_COVERAGE = 40;
const PAIR_GROUPS = ["th-s", "dh-z", "r-l", "v-w", "n-ng", "ih-iy", "ae-e"];
const MIN_PAIR_SENTENCES = 8;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const normText = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// ---------- 读取 ----------
let raw;
try {
  raw = fs.readFileSync(DATA_FILE, "utf8");
} catch (e) {
  console.error(`[x] 无法读取 ${DATA_FILE}: ${e.message}`);
  process.exit(1);
}
let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  console.error(`[x] JSON 解析失败: ${e.message}`);
  process.exit(1);
}
const sentences = doc?.sentences;
if (!Array.isArray(sentences)) {
  console.error("[x] 顶层缺少 sentences 数组");
  process.exit(1);
}

// ---------- 1. 条数 / id / text ----------
if (sentences.length !== EXPECTED_TOTAL) {
  err(`条数错误：期望 ${EXPECTED_TOTAL}，实际 ${sentences.length}`);
}

const idSeen = new Map();
const textSeen = new Map();
const dupTexts = [];
const byLevel = { A1: 0, A2: 0, B1: 0, B2: 0 };
const unknownLevels = new Map();

sentences.forEach((s, i) => {
  const where = s?.id ? `${s.id}` : `#${i}`;

  // 字段完整性
  for (const k of ["id", "text", "translation_zh", "level", "tags", "focus_phonemes"]) {
    if (!(k in s)) err(`${where}: 缺少字段 ${k}`);
  }
  const extra = Object.keys(s).filter(
    (k) => !["id", "text", "translation_zh", "level", "tags", "focus_phonemes"].includes(k),
  );
  if (extra.length) err(`${where}: 出现多余字段 ${extra.join(",")}（seed 按固定 schema 消费）`);

  if (typeof s.id !== "string" || !s.id.trim()) err(`${where}: id 不能为空`);
  if (typeof s.text !== "string" || !s.text.trim()) err(`${where}: text 不能为空`);
  if (typeof s.translation_zh !== "string" || !s.translation_zh.trim()) err(`${where}: translation_zh 不能为空`);

  // id 唯一 + 命名规范
  if (idSeen.has(s.id)) err(`id 重复：${s.id}（与 #${idSeen.get(s.id)} 重复）`);
  else idSeen.set(s.id, i);
  const expectPrefix = `s-${String(s.level ?? "").toLowerCase()}-`;
  if (typeof s.id === "string" && s.id && !new RegExp(`^s-${String(s.level).toLowerCase()}-\\d{2,3}$`).test(s.id)) {
    err(`${where}: id 命名不规范（应为 s-${String(s.level).toLowerCase()}-NN）`);
  }
  if (typeof s.id === "string" && s.id && !s.id.startsWith(expectPrefix)) {
    err(`${where}: id 前缀与 level 不匹配（level=${s.level}）`);
  }

  // text 归一化去重
  const n = normText(s.text);
  if (textSeen.has(n)) {
    dupTexts.push(`${s.id} 与 ${textSeen.get(n)} 重复：「${s.text}」`);
    err(`text 归一化后重复：${s.id} / ${textSeen.get(n)}`);
  } else {
    textSeen.set(n, s.id);
  }

  // level
  if (!(s.level in byLevel)) {
    unknownLevels.set(s.level, (unknownLevels.get(s.level) ?? 0) + 1);
    err(`${where}: 未知 level「${s.level}」`);
  } else {
    byLevel[s.level] += 1;
    const limit = TEXT_LIMIT[s.level];
    if (typeof s.text === "string" && s.text.length > limit) {
      err(`${where}: text 过长 ${s.text.length} > ${limit}（${s.level}）：「${s.text}」`);
    }
  }

  // tags
  if (!Array.isArray(s.tags) || s.tags.length === 0) err(`${where}: tags 必须是非空数组`);
  else if (s.tags.some((t) => typeof t !== "string" || !t.trim())) err(`${where}: tags 含空值`);

  // focus_phonemes
  if (!Array.isArray(s.focus_phonemes) || s.focus_phonemes.length === 0) {
    err(`${where}: focus_phonemes 必须是非空数组`);
  } else {
    if (s.focus_phonemes.length > 4) err(`${where}: focus_phonemes 最多 4 个，实际 ${s.focus_phonemes.length}`);
    if (new Set(s.focus_phonemes).size !== s.focus_phonemes.length) {
      err(`${where}: focus_phonemes 内部重复：${s.focus_phonemes.join(" ")}`);
    }
    const bad = s.focus_phonemes.filter((p) => !ALLOWED_SET.has(p));
    if (bad.length) err(`${where}: 非法 IPA 符号 ${bad.map((b) => `「${b}」`).join(" ")}（须用允许集合内的符号）`);
  }
});

for (const [lv, n] of unknownLevels) warn(`未知 level「${lv}」共 ${n} 条，未计入分布`);

// ---------- 2. 各 level 数量 ----------
for (const [lv, expected] of Object.entries(LEVEL_TARGET)) {
  const n = byLevel[lv] ?? 0;
  if (n !== expected) err(`${lv} 条数 ${n}，目标 ${expected}`);
  if (n < LEVEL_RANGE[0] || n > LEVEL_RANGE[1]) err(`${lv} 条数 ${n} 超出 ${LEVEL_RANGE[0]}–${LEVEL_RANGE[1]} 区间`);
}

// ---------- 3. 音素覆盖 ----------
const phonemeCount = new Map(ALLOWED.map((p) => [p, 0]));
for (const s of sentences) {
  if (!Array.isArray(s.focus_phonemes)) continue;
  for (const p of new Set(s.focus_phonemes)) {
    if (phonemeCount.has(p)) phonemeCount.set(p, phonemeCount.get(p) + 1);
  }
}
const covered = ALLOWED.filter((p) => phonemeCount.get(p) > 0);
if (covered.length < MIN_PHONEME_COVERAGE) {
  err(`音素覆盖数 ${covered.length} < 要求下限 ${MIN_PHONEME_COVERAGE}`);
}
const lowCoverage = ALLOWED.filter(
  (p) => !RETIRED_IN_CORPUS.includes(p) && phonemeCount.get(p) > 0 && phonemeCount.get(p) < MIN_PHONEME_SENTENCES,
);
const zeroCoverage = ALLOWED.filter((p) => !RETIRED_IN_CORPUS.includes(p) && phonemeCount.get(p) === 0);
const retiredUnused = RETIRED_IN_CORPUS.filter((p) => phonemeCount.get(p) === 0);
const retiredUsed = RETIRED_IN_CORPUS.filter((p) => phonemeCount.get(p) > 0);
for (const p of retiredUsed) {
  err(`音素「${p}」是 en-US 不存在的央化双元音，语料不应再使用（该写法会让卡片 key 与云端输出对不上）`);
}
if (retiredUnused.length > 0) {
  // 这是期望状态：3 个央化双元音已从语料中移除（tour=ʊr / bear=er / near=ɪr）
  console.log(`  已退役且语料中确实未使用: ${retiredUnused.join(" ")} ✓`);
}
for (const p of zeroCoverage) warn(`音素「${p}」没有任何句子覆盖`);
for (const p of lowCoverage) warn(`音素「${p}」仅 ${phonemeCount.get(p)} 句（< ${MIN_PHONEME_SENTENCES}）`);

// ---------- 4. 最小对立对 ----------
const pairGroups = new Map(PAIR_GROUPS.map((g) => [g, { count: 0, ids: [], levels: {} }]));
let minimalPairTotal = 0;
for (const s of sentences) {
  const tags = Array.isArray(s.tags) ? s.tags : [];
  if (!tags.includes("minimal-pair")) continue;
  minimalPairTotal += 1;
  const group = tags.find((t) => PAIR_GROUPS.includes(t));
  if (!group) {
    warn(`${s.id}: 标了 minimal-pair 但没有分组 tag（${PAIR_GROUPS.join("/")}）`);
    continue;
  }
  const g = pairGroups.get(group);
  g.count += 1;
  g.ids.push(s.id);
  g.levels[s.level] = (g.levels[s.level] ?? 0) + 1;
}
for (const [g, v] of pairGroups) {
  if (v.count < MIN_PAIR_SENTENCES) err(`最小对立对组「${g}」只有 ${v.count} 句（< ${MIN_PAIR_SENTENCES}）`);
}

// ---------- 输出 ----------
const out = [];
const line = (s = "") => out.push(s);

line("语料校验报告  Corpus validation report");
line(`数据文件: ${path.relative(process.cwd(), DATA_FILE)}`);
line("");
line(`总数: ${sentences.length} ${sentences.length === EXPECTED_TOTAL ? "✓" : `✗ (期望 ${EXPECTED_TOTAL})`}`);
line(`各 level: ${Object.entries(LEVEL_TARGET).map(([lv, n]) => `${lv}=${byLevel[lv] ?? 0}/${n}`).join("  ")}`);
// 各级别词数分布（B2 要求“真难”，这里给出可复核的量化）
const wordsOf = (t) => t.trim().split(/\s+/).length;
const distLine = Object.keys(LEVEL_TARGET)
  .map((lv) => {
    const arr = sentences.filter((s) => s.level === lv);
    if (arr.length === 0) return `${lv}: n/a`;
    const ws = arr.map((s) => wordsOf(s.text));
    const avg = (ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(1);
    return `${lv} 平均${avg}词/最长${Math.max(...ws)}词`;
  })
  .join("   ");
line(`词数分布: ${distLine}`);
line(`id 唯一: ${idSeen.size === sentences.length ? "✓" : "✗"}   text 重复: ${dupTexts.length === 0 ? "0 ✓" : `${dupTexts.length} ✗`}`);
for (const d of dupTexts.slice(0, 10)) line(`  ! ${d}`);
line("");
line(`音素覆盖: ${covered.length}/${ALLOWED.length} 个目标音素被使用  (要求 ≥ ${MIN_PHONEME_COVERAGE}) ${covered.length >= MIN_PHONEME_COVERAGE ? "✓" : "✗"}`);
line(`  元音(${VOWELS.length}): ${VOWELS.map((p) => `${p}=${phonemeCount.get(p)}`).join("  ")}`);
line(`  辅音(${CONSONANTS.length}): ${CONSONANTS.map((p) => `${p}=${phonemeCount.get(p)}`).join("  ")}`);
const lowList = [...zeroCoverage, ...lowCoverage];
line(
  `  低于 ${MIN_PHONEME_SENTENCES} 句的音素: ${lowList.length === 0 ? "无 ✓" : `${lowList.length} 个 → ${lowList.map((p) => `${p}(${phonemeCount.get(p)})`).join(" ")}`}`,
);
line(
  `  规范空间内但 en-US 无此音（语料已移除，不计 warning）: ${RETIRED_IN_CORPUS.join(" ")}` +
    ` —— tour=ʊr / bear=er / near=ɪr，语料里改写为句中真实的 ${"ʊ/e/ɪ"}`,
);
line("");
line(`最小对立对: ${minimalPairTotal} 句 覆盖 ${[...pairGroups.values()].filter((v) => v.count > 0).length}/${PAIR_GROUPS.length} 组 (每组要求 ≥ ${MIN_PAIR_SENTENCES})`);
for (const [g, v] of pairGroups) {
  const lv = Object.entries(v.levels).map(([k, n]) => `${k}:${n}`).join(" ");
  line(`  ${g.padEnd(6)} ${String(v.count).padStart(3)} 句  ${v.count >= MIN_PAIR_SENTENCES ? "✓" : "✗"}  ${lv}`);
}
line("");
line(`errors: ${errors.length}   warnings: ${warnings.length}`);
if (warnings.length) {
  line("-- warnings --");
  for (const w of warnings) line(`  ! ${w}`);
}
if (errors.length) {
  line("-- errors --");
  for (const e of errors) line(`  x ${e}`);
}
line(errors.length === 0 ? "结果: PASS (exit 0)" : "结果: FAIL (exit 1)");

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        total: sentences.length,
        byLevel,
        covered: covered.length,
        phonemes: Object.fromEntries(phonemeCount),
        retiredInCorpus: RETIRED_IN_CORPUS,
        minimalPairs: Object.fromEntries([...pairGroups].map(([g, v]) => [g, v.count])),
        minimalPairTotal,
        duplicates: dupTexts,
        errors,
        warnings,
        ok: errors.length === 0,
      },
      null,
      2,
    ),
  );
} else {
  console.log(out.join("\n"));
}

process.exit(errors.length === 0 ? 0 : 1);
