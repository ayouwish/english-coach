#!/usr/bin/env node
/**
 * 契约一致性强校验（独立验证工具，由 Lead 维护，不属于 voice 模块自测）
 *
 * 目的：不信任实现方的自测，直接按 docs/api-contract.md 的字段/枚举/类型逐项校验 voice 服务的真实响应。
 * 用法：
 *   node tests/contract_check.mjs                    # 默认 http://127.0.0.1:8100
 *   BASE=http://voice:8100 node tests/contract_check.mjs
 *
 * 退出码：0 全部通过；1 有硬性失败。
 */

const BASE = (process.env.BASE || 'http://127.0.0.1:8100').replace(/\/$/, '');

let pass = 0;
const failures = [];
const warnings = [];

function ok(name) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${detail}`);
}
function warn(name, detail) {
  warnings.push(`${name}: ${detail}`);
  console.log(`  \x1b[33m!\x1b[0m ${name} — ${detail}`);
}

function check(name, cond, detail = 'assertion failed') {
  if (cond) ok(name); else fail(name, detail);
  return !!cond;
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isStr(v) { return typeof v === 'string'; }
function isBool(v) { return typeof v === 'boolean'; }
function inEnum(v, set) { return set.includes(v); }

/** 校验一个分数：0-100 或 null（契约规定不可得必须为 null，不能是 0/-1） */
function scoreField(obj, key, label) {
  const v = obj?.[key];
  if (v === null || v === undefined) return null;
  if (!isNum(v)) { fail(`${label}.${key}`, `应为 number 或 null，实际 ${JSON.stringify(v)}`); return null; }
  if (v < 0 || v > 100) fail(`${label}.${key}`, `超出 0-100 范围：${v}`);
  else ok(`${label}.${key} = ${v}`);
  return v;
}

const ERROR_TYPES = ['None', 'Mispronunciation', 'Omission', 'Insertion', 'UnexpectedBreak', 'MissingBreak', 'Monotone'];
const SEVERITIES = ['high', 'medium', 'low'];
const INTONATION_ISSUES = ['expected_rise_but_flat', 'expected_fall_but_flat', 'wrong_direction', 'stress_misplaced', 'monotone_overall', 'unexpected_pause'];

/** 生成一段 16kHz 单声道 WAV：0.3s 220Hz + 0.4s 300Hz 扫频，用于真实触发 F0 提取与 DTW */
function makeWav(seconds = 1.6, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // 频率随时间从 180Hz 升到 260Hz，模拟一段有升降调的"语音"
    const f = 180 + 80 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / seconds));
    const env = Math.min(1, i / (0.05 * sampleRate)) * Math.min(1, (n - i) / (0.05 * sampleRate));
    const s = Math.sin(2 * Math.PI * f * t) * 0.6 * env;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function req(path, init) {
  const url = `${BASE}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json().catch(() => null) : await res.arrayBuffer();
    return { res, ct, body };
  } finally {
    clearTimeout(timer);
  }
}

function audioForm(extra = {}) {
  const fd = new FormData();
  fd.append('audio', new Blob([makeWav()], { type: 'audio/wav' }), 'probe.wav');
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return fd;
}

async function main() {
  console.log(`\n=== voice 契约一致性校验 @ ${BASE} ===\n`);
  const REF = 'I think the weather is really nice today.';

  // ---------- 1. health ----------
  console.log('[1/7] GET /v1/health');
  const h = await req('/v1/health');
  if (!check('health 返回 200', h.res.status === 200, `status=${h.res.status}`)) return finish();
  const health = h.body;
  check('health.status === "ok"', health?.status === 'ok', JSON.stringify(health));
  check('health.version 非空字符串', isStr(health?.version) && health.version.length > 0);
  check('health.mode ∈ mock|local|cloud|hybrid', inEnum(health?.mode, ['mock', 'local', 'cloud', 'hybrid']), `mode=${health?.mode}`);
  for (const k of ['asr', 'pa', 'tts', 'llm']) check(`health.providers.${k} 存在且为字符串`, isStr(health?.providers?.[k]));
  const caps = health?.capabilities;
  for (const k of ['phoneme_level', 'prosody', 'intonation_curve', 'nbest_phonemes', 'ssml', 'gpu']) {
    check(`health.capabilities.${k} 为 boolean`, isBool(caps?.[k]), `实际 ${JSON.stringify(caps?.[k])}`);
  }
  check('capabilities.intonation_curve 必须为 true（语调能力离线可用是硬要求）', caps?.intonation_curve === true);
  if (caps?.phoneme_level === false) {
    warn('capabilities.phoneme_level=false', '音素级不可用，pronounce 必须带 phoneme_level_unavailable warning 且降级为 word 粒度');
  }

  // ---------- 2. asr ----------
  console.log('\n[2/7] POST /v1/asr');
  const asr = await req('/v1/asr', { method: 'POST', body: audioForm({ language: 'en' }) });
  if (check('asr 返回 200', asr.res.status === 200, `status=${asr.res.status} body=${JSON.stringify(asr.body)?.slice(0, 300)}`)) {
    const a = asr.body;
    check('asr.text 为字符串', isStr(a?.text), JSON.stringify(a?.text));
    check('asr.language 为字符串', isStr(a?.language));
    check('asr.duration_ms 为正数', isNum(a?.duration_ms) && a.duration_ms > 0, `duration_ms=${a?.duration_ms}`);
    check('asr.words 为数组', Array.isArray(a?.words));
    if (Array.isArray(a?.words) && a.words.length) {
      const w = a.words[0];
      check('asr.words[].word/start_ms/end_ms/probability 字段齐全且类型正确',
        isStr(w.word) && isNum(w.start_ms) && isNum(w.end_ms) && isNum(w.probability));
    }
    check('asr.provider 为字符串', isStr(a?.provider));
  }

  // ---------- 3. pronounce ----------
  console.log('\n[3/7] POST /v1/pronounce （核心接口）');
  const pr = await req('/v1/pronounce', {
    method: 'POST',
    body: audioForm({
      reference_text: REF, mode: 'scripted', granularity: 'phoneme',
      with_intonation: 'true', tts_rate: 'slow', learner_age_band: 'adult',
    }),
  });
  let pron = null;
  if (check('pronounce 返回 200', pr.res.status === 200, `status=${pr.res.status} body=${JSON.stringify(pr.body)?.slice(0, 400)}`)) {
    pron = pr.body;
    check('provider 为字符串', isStr(pron?.provider));
    check('granularity ∈ phoneme|word', inEnum(pron?.granularity, ['phoneme', 'word']), `granularity=${pron?.granularity}`);
    check('mode ∈ scripted|unscripted', inEnum(pron?.mode, ['scripted', 'unscripted']));
    check('recognized_text 为字符串', isStr(pron?.recognized_text));
    check('duration_ms > 0', isNum(pron?.duration_ms) && pron.duration_ms > 0);

    // scores
    const s = pron?.scores;
    check('scores 对象存在', s && typeof s === 'object');
    for (const k of ['pron', 'accuracy', 'fluency', 'completeness', 'prosody']) {
      if (!(k in (s || {}))) fail(`scores.${k}`, '字段缺失（不可得时必须显式返回 null）');
      else scoreField(s, k, 'scores');
    }
    if (s?.pron === 0) fail('scores.pron 为 0', '0 与"不可得"无法区分，若不可得应返回 null');

    // 降级一致性：phoneme_level=false 时必须是 word 粒度 + 对应 warning
    if (caps?.phoneme_level === false) {
      check('音素能力为假时 granularity 降级为 word', pron?.granularity === 'word', `granularity=${pron?.granularity}`);
      check('音素能力为假时 warnings 含 phoneme_level_unavailable',
        Array.isArray(pron?.warnings) && pron.warnings.includes('phoneme_level_unavailable'),
        `warnings=${JSON.stringify(pron?.warnings)}`);
    }

    // words
    check('words 为数组', Array.isArray(pron?.words));
    if (Array.isArray(pron?.words) && pron.words.length) {
      const w = pron.words[0];
      check('words[] 基础字段齐全', isStr(w.word) && isNum(w.start_ms) && isNum(w.end_ms));
      check('words[].score 为 0-100 或 null', w.score === null || (isNum(w.score) && w.score >= 0 && w.score <= 100));
      check('words[].error_type ∈ 契约枚举', inEnum(w.error_type, ERROR_TYPES), `error_type=${w.error_type}`);
      check('words[].phonemes 为数组', Array.isArray(w.phonemes));
      if (pron.granularity === 'phoneme' && Array.isArray(w.phonemes) && w.phonemes.length) {
        const p = w.phonemes[0];
        check('phonemes[] 字段齐全', isStr(p.phoneme) && isNum(p.score) && isNum(p.start_ms) && isNum(p.end_ms));
        if (caps?.nbest_phonemes) {
          check('phonemes[].nbest 为数组（NBest 能力声明为 true）', Array.isArray(p.nbest));
        }
      }
    }

    // issues
    check('issues 为数组', Array.isArray(pron?.issues));
    if (Array.isArray(pron?.issues)) {
      check('issues 条数 ≤ 5（契约上限）', pron.issues.length <= 5, `实际 ${pron.issues.length} 条`);
      let prev = 4;
      let sortedOk = true;
      const rank = { high: 3, medium: 2, low: 1 };
      for (const it of pron.issues) {
        if (!inEnum(it.type, ERROR_TYPES)) fail('issues[].type', `非法枚举 ${it.type}`);
        if (!inEnum(it.severity, SEVERITIES)) fail('issues[].severity', `非法枚举 ${it.severity}`);
        if (it.hint_key !== undefined && it.hint_key !== null && !isStr(it.hint_key)) fail('issues[].hint_key', '应为字符串');
        if (rank[it.severity] > prev) sortedOk = false;
        prev = rank[it.severity] ?? 0;
      }
      check('issues 按 severity 降序排列', sortedOk, '严重度未降序');
    }

    // intonation
    const it = pron?.intonation;
    check('intonation 对象存在', it && typeof it === 'object');
    check('intonation.available 为 boolean', isBool(it?.available));
    if (it?.available) {
      check('intonation.dtw_distance 为有限数', isNum(it.dtw_distance), `dtw_distance=${it.dtw_distance}`);
      const uf = it.user_f0, rf = it.reference_f0;
      check('user_f0 / reference_f0 为数组', Array.isArray(uf) && Array.isArray(rf));
      check('两条 F0 曲线等长（必须已 DTW 对齐到同一时间轴）', Array.isArray(uf) && Array.isArray(rf) && uf.length === rf.length,
        `user=${uf?.length} ref=${rf?.length}`);
      check('F0 点数 ≤ 600（契约上限）', Array.isArray(uf) && uf.length <= 600, `实际 ${uf?.length}`);
      if (Array.isArray(uf) && uf.length) {
        const pt = uf[0];
        check('F0 点是 [time_ms, f0|null] 二元组', Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && (pt[1] === null || isNum(pt[1])),
          JSON.stringify(pt));
        const voiced = uf.filter((p) => Array.isArray(p) && p[1] !== null).length;
        check('user_f0 含浊音帧（说明真的做了 F0 提取，不是空壳）', voiced > 0, `浊音帧=${voiced}`);
      }
      check('worst_regions 为数组', Array.isArray(it.worst_regions));
      if (Array.isArray(it.worst_regions)) {
        for (const r of it.worst_regions) {
          if (!isNum(r.start_ms) || !isNum(r.end_ms)) fail('worst_regions[].start_ms/end_ms', '应为数字');
          if (!inEnum(r.issue, INTONATION_ISSUES)) fail('worst_regions[].issue', `非法枚举 ${r.issue}`);
        }
        ok(`worst_regions 枚举与字段校验（${it.worst_regions.length} 条）`);
      }
      if (it.reference_audio_url !== null && it.reference_audio_url !== undefined) {
        check('reference_audio_url 以 /voice/v1/audio/ 开头（同源相对路径，供浏览器直接播放）',
          isStr(it.reference_audio_url) && it.reference_audio_url.startsWith('/voice/v1/audio/'),
          `实际 ${it.reference_audio_url}`);
      }
    } else {
      fail('intonation.available === false', '契约要求语调计算不依赖云 API，任何 provider 下都应可用');
    }
    check('warnings 为数组', Array.isArray(pron?.warnings));
  }

  // ---------- 4. tts ----------
  console.log('\n[4/7] POST /v1/tts');
  const tts = await req('/v1/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'think, thank, three', rate: 'slow', format: 'mp3' }),
  });
  if (check('tts 返回 200', tts.res.status === 200, `status=${tts.res.status}`)) {
    const ct = tts.ct || '';
    check('tts Content-Type 为音频', ct.startsWith('audio/'), `content-type=${ct}`);
    check('tts 返回非空音频字节', tts.body instanceof ArrayBuffer && tts.body.byteLength > 0, `bytes=${tts.body?.byteLength}`);
    check('tts 带 X-TTS-Provider 响应头', !!tts.res.headers.get('x-tts-provider'));
  }

  // ---------- 5. feedback ----------
  console.log('\n[5/7] POST /v1/feedback');
  const fb = await req('/v1/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reference_text: REF,
      scores: pron?.scores ?? { pron: 72, accuracy: 78, fluency: 80, completeness: 100, prosody: 61 },
      issues: (pron?.issues ?? []).slice(0, 2),
      intonation: pron?.intonation ? { dtw_distance: pron.intonation.dtw_distance, worst_regions: pron.intonation.worst_regions } : null,
      learner: { age_band: 'adult', level: 'B1', native_language: 'zh' },
    }),
  });
  if (check('feedback 返回 200', fb.res.status === 200, `status=${fb.res.status} body=${JSON.stringify(fb.body)?.slice(0, 300)}`)) {
    const f = fb.body;
    check('feedback.provider 为字符串', isStr(f?.provider));
    check('feedback.summary 为非空字符串', isStr(f?.summary) && f.summary.length > 0);
    check('feedback.points 为数组且 ≤ 2（契约硬约束：一次最多纠 2 个问题）',
      Array.isArray(f?.points) && f.points.length <= 2, `实际 ${f?.points?.length} 条`);
    if (Array.isArray(f?.points)) {
      for (const p of f.points) {
        const good = isStr(p.title) && isStr(p.why) && isStr(p.how) && Array.isArray(p.practice_words);
        if (!good) fail('feedback.points[] 字段', `需要 title/why/how/practice_words，实际 ${JSON.stringify(p).slice(0, 200)}`);
      }
      if (f.points.length) ok('feedback.points[] 字段齐全（title/why/how/practice_words）');
    }
  }

  // ---------- 5b. feedback 儿童模式 ----------
  const fbKid = await req('/v1/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reference_text: 'This is my cat.',
      scores: { pron: 65, accuracy: 60, fluency: 70, completeness: 90, prosody: 55 },
      issues: [{ type: 'Mispronunciation', word: 'this', phoneme: 'ð', actual: 'd', score: 40 }],
      intonation: null,
      learner: { age_band: 'child', level: 'A1', native_language: 'zh' },
    }),
  });
  if (check('feedback(child) 返回 200', fbKid.res.status === 200, `status=${fbKid.res.status}`)) {
    const txt = JSON.stringify(fbKid.body);
    // 儿童模式不得把 IPA 符号直接甩给孩子
    const ipaHits = ['/θ/', '/ð/', '/æ/', '/ŋ/', 'ˈ', 'ə'].filter((sym) => txt.includes(sym));
    if (ipaHits.length) warn('feedback(child) 含 IPA 符号', `命中 ${ipaHits.join(' ')} —— 契约要求儿童模式避开 IPA 符号`);
    else ok('feedback(child) 未出现 IPA 符号');
    check('feedback(child) provider 有值（不可用时应降级为 template 而非报错）', isStr(fbKid.body?.provider));
  }

  // ---------- 6. dialogue ----------
  console.log('\n[6/7] POST /v1/dialogue');
  const dl = await req('/v1/dialogue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scenario: {
        id: 'ordering_coffee', title: 'Ordering coffee', title_zh: '在咖啡店点单',
        setting_zh: '你是一名咖啡店店员，学习者是顾客。',
        role_prompt: 'You are a friendly barista. Keep each reply under 15 words.',
        opening_line: 'Hi there! What can I get for you today?',
        level: 'A2', min_age: 6,
      },
      learner: { age_band: 'child', level: 'A2', native_language: 'zh', child_safe: true },
      history: [
        { role: 'assistant', text: 'Hi there! What can I get for you today?' },
        { role: 'user', text: 'I want a coffee.' },
      ],
      correction_level: 'gentle',
      turn_index: 1,
    }),
  });
  if (check('dialogue 返回 200', dl.res.status === 200, `status=${dl.res.status} body=${JSON.stringify(dl.body)?.slice(0, 300)}`)) {
    const d = dl.body;
    check('dialogue.provider 为字符串', isStr(d?.provider));
    check('dialogue.reply 为非空字符串', isStr(d?.reply) && d.reply.length > 0);
    check('dialogue.reply_zh 为字符串（儿童模式必需中文翻译）', isStr(d?.reply_zh));
    check('dialogue.suggested_replies 为 2-3 条（降低开口门槛的关键字段）',
      Array.isArray(d?.suggested_replies) && d.suggested_replies.length >= 2 && d.suggested_replies.length <= 3,
      `实际 ${JSON.stringify(d?.suggested_replies)}`);
    check('dialogue.target_words 为数组', Array.isArray(d?.target_words));
    check('dialogue.flag ∈ ok|unsafe_filtered|off_topic', inEnum(d?.flag, ['ok', 'unsafe_filtered', 'off_topic']), `flag=${d?.flag}`);
    check('dialogue.done 为 boolean', isBool(d?.done));
    const c = d?.correction;
    if (check('dialogue.correction 对象存在', c && typeof c === 'object')) {
      check('correction.has_error 为 boolean', isBool(c.has_error));
      if (c.has_error) {
        check('correction.type ∈ 契约枚举', inEnum(c.type, ['grammar', 'vocabulary', 'politeness', 'pronunciation', 'none']), `type=${c.type}`);
        check('correction 带 original/better/explain_zh', isStr(c.original) && isStr(c.better) && isStr(c.explain_zh));
        check('correction.severity ∈ high|medium|low', inEnum(c.severity, SEVERITIES));
      }
    }
  }

  // ---------- 7. audio ----------
  console.log('\n[7/7] GET /v1/audio/{id}');
  const refUrl = pron?.intonation?.reference_audio_url;
  if (refUrl) {
    const path = refUrl.replace(/^\/voice/, '');
    const au = await req(path);
    if (check('示范音频可取回 200', au.res.status === 200, `status=${au.res.status} path=${path}`)) {
      check('示范音频 Content-Type 为音频', (au.ct || '').startsWith('audio/'), `content-type=${au.ct}`);
      check('示范音频非空', au.body instanceof ArrayBuffer && au.body.byteLength > 0, `bytes=${au.body?.byteLength}`);
      check('示范音频带 Cache-Control（契约要求可缓存）', !!au.res.headers.get('cache-control'));
    }
  } else {
    warn('跳过 /v1/audio 校验', 'pronounce 未返回 reference_audio_url');
  }
  const missing = await req('/v1/audio/ref_doesnotexist000.wav');
  if (check('不存在的 audio_id 返回 404', missing.res.status === 404, `status=${missing.res.status}`)) {
    check('404 响应体符合统一错误格式 {error:{code,message}}',
      isStr(missing.body?.error?.code) && isStr(missing.body?.error?.message), JSON.stringify(missing.body));
  }

  // ---------- 8. warmup（契约 v1.1 §12）----------
  console.log('\n[8] POST /v1/warmup（v1.1 缓存预热）');
  const stamp = Date.now();
  const freshText = `Warmup probe ${stamp}.`;      // 随机后缀 → 必然未命中，用来证明真的会生成
  const dupText = 'Please warm up this cached sentence.';  // 固定文本，用来证明幂等
  const warmBody = {
    items: [
      { text: freshText, rate: 'normal' },
      { text: dupText, rate: 'slow' },
      { text: dupText, rate: 'slow' },   // 故意重复 → 应计入 skipped_duplicates
    ],
    concurrency: 2,
  };
  const w1 = await req('/v1/warmup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(warmBody) });
  if (check('warmup 返回 200', w1.res.status === 200, `status=${w1.res.status} body=${JSON.stringify(w1.body)?.slice(0, 300)}`)) {
    const w = w1.body;
    for (const k of ['requested', 'generated', 'cached', 'failed', 'skipped_duplicates', 'elapsed_ms']) {
      check(`warmup.${k} 字段存在且类型正确`,
        k === 'failed' ? Array.isArray(w?.[k]) : isNum(w?.[k]), `${k}=${JSON.stringify(w?.[k])}`);
    }
    check('warmup.cache 带 audio_entries/f0_entries/bytes', isNum(w?.cache?.audio_entries) && isNum(w?.cache?.f0_entries) && isNum(w?.cache?.bytes),
      JSON.stringify(w?.cache));
    // §12.4：计数必须自洽
    const sum = (w?.generated ?? 0) + (w?.cached ?? 0) + (w?.failed?.length ?? 0) + (w?.skipped_duplicates ?? 0);
    check('§12.4 计数自洽：requested = generated + cached + failed + skipped_duplicates',
      sum === w?.requested, `${w?.generated}+${w?.cached}+${w?.failed?.length}+${w?.skipped_duplicates}=${sum} ≠ requested=${w?.requested}`);
    check('重复项被识别（skipped_duplicates ≥ 1）', (w?.skipped_duplicates ?? 0) >= 1, `skipped_duplicates=${w?.skipped_duplicates}`);
    check('新文本确实被生成（generated ≥ 1）', (w?.generated ?? 0) >= 1, `generated=${w?.generated}`);
    check('生成失败项为 0（预热不应静默丢条目）', (w?.failed?.length ?? 0) === 0,
      `failed=${JSON.stringify(w?.failed)}`);

    // 幂等：第二次必须全部命中缓存、generated=0
    const w2 = await req('/v1/warmup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(warmBody) });
    if (check('warmup 第二次调用返回 200', w2.res.status === 200, `status=${w2.res.status}`)) {
      const v = w2.body;
      check('§12.4 幂等：第二次 generated=0', v?.generated === 0, `generated=${v?.generated}`);
      check('§12.4 幂等：第二次 cached = requested - skipped_duplicates',
        v?.cached === (v?.requested ?? 0) - (v?.skipped_duplicates ?? 0),
        `cached=${v?.cached} requested=${v?.requested} skipped=${v?.skipped_duplicates}`);
      const sum2 = (v?.generated ?? 0) + (v?.cached ?? 0) + (v?.failed?.length ?? 0) + (v?.skipped_duplicates ?? 0);
      check('第二次计数仍自洽', sum2 === v?.requested, `${sum2} ≠ ${v?.requested}`);
    }

    // 上限与非法输入
    const tooMany = await req('/v1/warmup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.from({ length: 501 }, (_, i) => ({ text: `sentence ${i}` })) }),
    });
    check('items > 500 返回 413 payload_too_large', tooMany.res.status === 413 && tooMany.body?.error?.code === 'payload_too_large',
      `status=${tooMany.res.status} code=${tooMany.body?.error?.code}`);
    const emptyText = await req('/v1/warmup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: '' }] }),
    });
    check('空 text 返回 400 bad_request', emptyText.res.status === 400 && emptyText.body?.error?.code === 'bad_request',
      `status=${emptyText.res.status} code=${emptyText.body?.error?.code}`);
  }

  // ---------- 9. provider_meta.cache（契约 v1.1 §12.5）----------
  console.log('\n[9] /v1/pronounce 的 provider_meta.cache（miss → hit）');
  const cacheText = `Cache probe ${stamp} for metadata.`;
  const p1 = await req('/v1/pronounce', { method: 'POST', body: audioForm({ reference_text: cacheText, mode: 'scripted' }) });
  const p2 = await req('/v1/pronounce', { method: 'POST', body: audioForm({ reference_text: cacheText, mode: 'scripted' }) });
  if (check('两次 pronounce 均 200', p1.res.status === 200 && p2.res.status === 200, `${p1.res.status}/${p2.res.status}`)) {
    const c1 = p1.body?.provider_meta?.cache, c2 = p2.body?.provider_meta?.cache;
    if (check('provider_meta.cache 存在（v1.1 §12.5 要求）', !!c1 && !!c2, `第一次=${JSON.stringify(c1)} 第二次=${JSON.stringify(c2)}`)) {
      check('cache.reference_audio 取值合法', ['hit', 'miss', 'disabled'].includes(c1?.reference_audio) && ['hit', 'miss', 'disabled'].includes(c2?.reference_audio),
        `${c1?.reference_audio} / ${c2?.reference_audio}`);
      check('首次为 miss、第二次为 hit（证明缓存真的生效）',
        c1?.reference_audio === 'miss' && c2?.reference_audio === 'hit',
        `第一次=${c1?.reference_audio} 第二次=${c2?.reference_audio}`);
      check('cache.reference_f0 同样是 miss → hit',
        c1?.reference_f0 === 'miss' && c2?.reference_f0 === 'hit',
        `第一次=${c1?.reference_f0} 第二次=${c2?.reference_f0}`);
      // 缓存不能改变结果语义：两次的分数必须一致
      check('命中缓存不改变评测结果（两次 scores 完全一致）',
        JSON.stringify(p1.body?.scores) === JSON.stringify(p2.body?.scores),
        `${JSON.stringify(p1.body?.scores)} vs ${JSON.stringify(p2.body?.scores)}`);
      check('命中缓存后 F0 曲线仍完整返回', Array.isArray(p2.body?.intonation?.user_f0) && p2.body.intonation.user_f0.length > 0,
        `点数=${p2.body?.intonation?.user_f0?.length}`);
    }
    if (isNum(p1.body?.duration_ms) && isNum(p2.body?.duration_ms)) {
      console.log(`    两次调用音频时长：${p1.body.duration_ms}ms / ${p2.body.duration_ms}ms（缓存不应改变识别结果）`);
    }
  }

  // ---------- 错误格式 ----------
  console.log('\n[附加] 统一错误格式');
  const bad = await req('/v1/pronounce', { method: 'POST', body: audioForm({ reference_text: REF, mode: 'not_a_mode' }) });
  if (bad.res.status >= 400) {
    check('非法参数返回 4xx 且响应体为 {error:{code,message}}',
      isStr(bad.body?.error?.code) && isStr(bad.body?.error?.message), `status=${bad.res.status} body=${JSON.stringify(bad.body)?.slice(0, 200)}`);
  } else {
    warn('/v1/pronounce 对非法 mode 未报错', `返回 ${bad.res.status}（宽松处理可接受，但需确认不是静默错误）`);
  }

  finish();
}

function finish() {
  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${failures.length} 项，警告 ${warnings.length} 项 ===`);
  if (warnings.length) {
    console.log('\n警告：');
    warnings.forEach((w) => console.log(`  ! ${w}`));
  }
  if (failures.length) {
    console.log('\n失败明细（需要实现方修复）：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log('\n\x1b[32m契约一致性校验全部通过。\x1b[0m\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n校验脚本本身异常：', e);
  console.error('（若为 fetch failed / ECONNREFUSED，说明 voice 服务没起来）');
  process.exit(1);
});
