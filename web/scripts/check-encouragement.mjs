#!/usr/bin/env node
/**
 * task-45 验收：读完后按表现分级播放鼓励语音（纯逻辑 + 源码断言，无浏览器）。
 *
 * 断言：
 *  1. 6 个档位都有文案、每档池大小 4–6
 *  2. 分档正确：S（≥85 或比上次 +8）/ A（70–84）/ B（55–69）/ C（<55）
 *  3. 特殊两档：没听到（noSpeech / pron null）、没读完（completeness < 60）
 *  4. **确定性**：同一 attemptId 多次选择结果一致（不用 Math.random）
 *  5. 连续 20 次不重复：最近 3 次内不出现同一条
 *  6. 文案池**不含否定词**（错/差/失败/不行/不好…）
 *  7. 具体化：+N 分 / 音素（复用 articulation.ts，且不含 IPA）/ 单词
 *  8. 源码：/flow 引用 EncouragementBox；组件含中英两句；voice 显式传入；无 Math.random
 *
 * 用法：node scripts/check-encouragement.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import module from "node:module";

// Node 直接 import TS 时不会像 Next/TS 那样自动补 .ts 后缀；这里注册一个解析钩子，
// 让 `./articulation` 这类无后缀相对导入也能解析到 `./articulation.ts`（项目内的写法保持不变）。
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          /* 交给默认解析 */
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IPA_RE = /[θðɹŋæʃɪʌɔɜəʊʒɑɒɛˈˌ]/;

const {
  ENCOURAGEMENT_POOLS,
  NEGATIVE_WORDS,
  buildEncouragement,
  hashString,
  pickTier,
  pickVariant,
  shortPhonemeName,
  specificPraise,
  TIER_LABELS,
} = await import(path.join(WEB_ROOT, "src/lib/encouragement.ts"));

let failed = 0;
const rows = [];
const check = (name, cond, detail = "") => {
  if (!cond) failed += 1;
  rows.push({ ok: Boolean(cond), name });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n──────── ${t} ────────`);

const TIERS = ["S", "A", "B", "C", "no_speech", "incomplete"];

section("1. 文案池：6 档、每档 4–6 条");
for (const tier of TIERS) {
  const pool = ENCOURAGEMENT_POOLS[tier] ?? [];
  check(`${TIER_LABELS[tier]}（${tier}）池大小 4–6`, pool.length >= 4 && pool.length <= 6, `${pool.length} 条`);
  check(
    `${tier} 每条都有中文+英文`,
    pool.every((v) => typeof v.zh === "string" && v.zh.length > 0 && typeof v.en === "string" && v.en.length > 0),
  );
}

section("2. 分档规则");
check("pron=90 → S", pickTier({ pron: 90 }) === "S");
check("pron=78 且比上次 +8 → S", pickTier({ pron: 78, prevPron: 70 }) === "S");
check("pron=84 → A", pickTier({ pron: 84 }) === "A");
check("pron=70 → A", pickTier({ pron: 70 }) === "A");
check("pron=69 → B", pickTier({ pron: 69 }) === "B");
check("pron=55 → B", pickTier({ pron: 55 }) === "B");
check("pron=54 → C", pickTier({ pron: 54 }) === "C");
check("pron=null → 没听到", pickTier({ pron: null }) === "no_speech");
check("noSpeech=true → 没听到", pickTier({ pron: 80, noSpeech: true }) === "no_speech");
check("completeness=40 → 没读完", pickTier({ pron: 80, completeness: 40 }) === "incomplete");
check("completeness=100 且 pron=80 → A", pickTier({ pron: 80, completeness: 100 }) === "A");

section("3. 确定性（无 Math.random）");
{
  const a = pickVariant("A", "att_same_seed");
  const b = pickVariant("A", "att_same_seed");
  check("同一 attemptId 选到同一条", a.zh === b.zh, a.zh);
  const c1 = buildEncouragement({ attemptId: "att_x", pron: 88 });
  const c2 = buildEncouragement({ attemptId: "att_x", pron: 88 });
  check("buildEncouragement 结果稳定", c1.zh === c2.zh && c1.tier === c2.tier, `${c1.tier}/${c1.zh}`);
  check("hashString 稳定且非负", hashString("abc") === hashString("abc") && hashString("abc") >= 0, String(hashString("abc")));
}

section("4. 连续 20 次：最近 3 次内不重复");
for (const tier of TIERS) {
  const recent = [];
  let ok = true;
  const picked = [];
  for (let i = 0; i < 20; i++) {
    const v = pickVariant(tier, `att_${tier}_${i}`, recent);
    if (recent.includes(v.zh)) {
      ok = false;
      break;
    }
    picked.push(v.zh);
    recent.push(v.zh);
    while (recent.length > 3) recent.shift();
  }
  check(`${TIER_LABELS[tier]}（${tier}）20 次不连续重复`, ok, picked.slice(0, 3).map((s) => s.slice(0, 10)).join(" / "));
}

section("5. 文案池无否定词");
for (const tier of TIERS) {
  for (const v of ENCOURAGEMENT_POOLS[tier]) {
    const hit = NEGATIVE_WORDS.filter((w) => v.zh.includes(w) || v.en.toLowerCase().includes(w));
    check(`${tier}「${v.zh.slice(0, 12)}…」不含否定词`, hit.length === 0, hit.join(","));
  }
}

section("6. 具体化（进步 / 音素 / 单词，绝不编造）");
{
  const deltaPraise = specificPraise({ deltaPron: 6, isChild: true });
  check("比上次高 6 分 → 具体化句", deltaPraise === "比上次高了 6 分！", deltaPraise ?? "");
  const phonemePraise = specificPraise({ phonemes: [{ phoneme: "θ", score: 92 }] });
  check("θ 得 92 分 → 提到 th 且不含 IPA", Boolean(phonemePraise) && phonemePraise.includes("th") && !IPA_RE.test(phonemePraise), phonemePraise ?? "");
  const wordPraise = specificPraise({ words: [{ word: "three", score: 91 }] });
  check("单词 three 91 分 → 具体化句", wordPraise?.includes("three") === true, wordPraise ?? "");
  check("取不到具体项 → null（不编造）", specificPraise({ deltaPron: 1, phonemes: [], words: [] }) === null);
  const nameO = shortPhonemeName("θ");
  check("shortPhonemeName(θ) 非空且非 IPA", Boolean(nameO) && !IPA_RE.test(nameO), nameO ?? "");
  check("未知音素 → null", shortPhonemeName("zzz") === null);
}

section("7. 源码断言：/flow 引用 + 中英双语 + 显式 voice");
{
  const flowSrc = fs.readFileSync(path.join(WEB_ROOT, "src/app/flow/FlowClient.tsx"), "utf8");
  check("★ /flow 引用 EncouragementBox", flowSrc.includes('from "@/components/EncouragementBox"') && flowSrc.includes("<EncouragementBox"));
  const compSrc = fs.readFileSync(path.join(WEB_ROOT, "src/components/EncouragementBox.tsx"), "utf8");
  check("★ 组件展示中英两句（encouragement-zh / encouragement-en）", compSrc.includes('data-testid="encouragement-zh"') && compSrc.includes('data-testid="encouragement-en"'));
  check("★ 显式传 voice（中文 + 英文两个音色）", compSrc.includes("zh-CN-XiaoxiaoNeural") && compSrc.includes("en-US-JennyNeural") && /voice,\s*rate/.test(compSrc.replace(/\s+/g, " ")));
  check("中文 → 300ms → 英文（顺序播放）", compSrc.includes("ZH_VOICE") && compSrc.includes("EN_VOICE") && compSrc.includes("GAP_MS") && /GAP_MS = 300/.test(compSrc));
  check("★ 无 Math.random（确定性，避免水合不一致）", !compSrc.includes("Math.random"));
  check("自动播被拦 → 可见降级提示 + 按钮", compSrc.includes('data-testid="encouragement-blocked"') && compSrc.includes('data-testid="encouragement-play"'));
  check("语音失败 → 可见提示（不静默）", compSrc.includes('data-testid="encouragement-error"') && compSrc.includes("语音暂时不可用"));
  check("文案不写 markdown 星号", !compSrc.includes("**") && !fnHasDoubleStar());
}

function fnHasDoubleStar() {
  return TIERS.some((t) => ENCOURAGEMENT_POOLS[t].some((v) => v.zh.includes("**") || v.en.includes("**")));
}

section("8. 每档实际选出的样例");
for (const tier of TIERS) {
  const v = pickVariant(tier, `sample_${tier}`);
  console.log(`   ${TIER_LABELS[tier]}（${tier}）：${v.zh} ／ ${v.en}`);
}

console.log(`\n共 ${rows.length} 项断言，通过 ${rows.length - failed}，失败 ${failed}`);
console.log(failed === 0 ? "结论：全部通过 ✅" : "结论：存在失败 ❌");
process.exit(failed > 0 ? 1 : 0);
