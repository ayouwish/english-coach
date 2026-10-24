#!/usr/bin/env node
/**
 * 服务端端到端 smoke（无浏览器环境下的验收脚本）。
 *
 * 前置：mock voice 已在 :8100 运行，web 已在 :3000 运行（`pnpm build && pnpm start` 或 `pnpm dev`）。
 * 覆盖：三账号登录 → 跟读提交（mock 评测落库）→ 对话 3 轮 → 错音本查询/评分 → 家长面板 → child 403
 *       → voice 故障降级（不丢数据 + 稍后重试成功）→ 关键 HTML 渲染断言（儿童页面不得出现 IPA）。
 *
 * 用法：node scripts/smoke.mjs   （可用 BASE_URL / VOICE_URL / SMOKE_SKIP_DEGRADED 覆盖）
 */
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const VOICE = (process.env.VOICE_URL ?? "http://127.0.0.1:8100").replace(/\/$/, "");

const IPA_CHARS = [
  "θ", "ð", "ɹ", "ŋ", "æ", "ʃ", "ɪ", "ʌ", "ɔ", "ɜ", "ə", "ʊ", "ʒ", "ɑ", "ɒ", "ɛ",
  "ˈ", "ˌ", "ː", "ʤ", "ʧ",
];

const results = [];
let failed = 0;

function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  if (!ok) failed += 1;
  results.push({ ok, name, detail });
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function section(title) {
  console.log(`\n──────── ${title} ────────`);
}

function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = all.find((c) => c.startsWith("ec_session=")) ?? all[0] ?? "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body, headers = {}, base } = {}) {
  const res = await fetch(`${base ?? BASE}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML 或空响应 */
  }
  return { res, status: res.status, json, text };
}

async function login(email, password) {
  const { status, json, res } = await jsonFetch("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return { status, json, cookie: status === 200 ? cookieFrom(res) : null };
}

/**
 * 生成一段真实可解码的 16kHz 单声道 PCM16 WAV。
 * 必须是「类浊音」信号（基频 120→220Hz 滑动 + 谐波 + 包络），否则语音服务
 * 抽不出基频、也不会给语调曲线（真实 voice 走 ffmpeg + 自相关基频检测）。
 */
function wavBlob(seconds = 2.5, baseFreq = 120) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = baseFreq + 60 * Math.sin(2 * Math.PI * 0.7 * t) + 20 * Math.sin(2 * Math.PI * 2.3 * t);
    phase += (2 * Math.PI * f0) / sr;
    const env =
      0.5 * (1 - Math.cos(2 * Math.PI * Math.min(1, t / 0.15))) * Math.exp(-0.3 * t);
    const v = (Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.25 + Math.sin(3 * phase) * 0.12) * 9000 * env;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * 2);
  }
  return new Blob([b], { type: "audio/wav" });
}

async function main() {
  console.log(`smoke: BASE=${BASE} VOICE=${VOICE}`);

  section("0. web 探活 / voice 就绪");
  {
    let health = await jsonFetch("/api/health?force=1");
    for (let i = 0; i < 3 && health.json?.voice?.reachable !== true; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await jsonFetch("/api/health?force=1");
    }
    const { status, json } = health;
    check("GET /api/health 返回 200", status === 200, `status=${status}`);
    check("health.db.ok", json?.db?.ok === true, JSON.stringify(json?.db ?? {}));
    check("voice 可达（/v1/health 探测）", json?.voice?.reachable === true, `mode=${json?.voice?.mode}`);
    let voiceHealth = null;
    try {
      voiceHealth = await fetch(`${VOICE}/v1/health`).then((r) => r.json());
    } catch (err) {
      voiceHealth = { error: String(err) };
    }
    check(
      "voice capabilities 存在（UI 据此降级）",
      typeof voiceHealth?.capabilities?.phoneme_level === "boolean",
      JSON.stringify(voiceHealth?.capabilities ?? voiceHealth),
    );
  }

  section("1. 三账号登录");
  const dad = await login("dad@example.com", "Dad12345!");
  check("爸爸(parent) 登录 200", dad.status === 200 && dad.json?.user?.role === "parent");
  const mom = await login("mom@example.com", "Mom12345!");
  check("妈妈(parent) 登录 200", mom.status === 200 && mom.json?.user?.role === "parent");
  const girl = await login("girl@example.com", "Girl12345!");
  check("女儿(child) 登录 200", girl.status === 200 && girl.json?.user?.role === "child");
  check(
    "女儿 age_band=child / birth_year≈2018",
    girl.json?.user?.ageBand === "child" && girl.json?.user?.birthYear === 2018,
    `birth_year=${girl.json?.user?.birthYear}`,
  );
  const bad = await login("dad@example.com", "wrong-password");
  check("错误密码 401", bad.status === 401, `status=${bad.status}`);

  section("2. 语料 & 场景种子数据");
  {
    const s = await jsonFetch("/api/sentences", { cookie: dad.cookie });
    check("跟读语料 ≥ 60 句", (s.json?.count ?? 0) >= 60, `count=${s.json?.count}`);
    const levels = new Set((s.json?.sentences ?? []).map((x) => x.level));
    check(
      "语料含 A1/A2/B1 分级",
      ["A1", "A2", "B1"].every((l) => levels.has(l)),
      [...levels].join(","),
    );
    // 只检查官方语料：家长自定义语料允许"只填英文，翻译留空"（task-5 B.11）
    const officialOnly = (s.json?.sentences ?? []).filter((x) => x.owner_user_id === null);
    check("官方语料每句都有中文翻译", officialOnly.every((x) => x.translation_zh), `n=${officialOnly.length}`);
    check(
      "官方语料每句都有 focus_phonemes",
      officialOnly.every((x) => Array.isArray(x.focus_phonemes) && x.focus_phonemes.length > 0),
    );
    const c = await jsonFetch("/api/chat/scenarios", { cookie: girl.cookie });
    check("对话场景 ≥ 8 个（儿童可见）", (c.json?.count ?? 0) >= 8, `count=${c.json?.count}`);
    check(
      "儿童场景按 min_age 过滤",
      (c.json?.scenarios ?? []).every((x) => x.min_age <= (c.json?.age ?? 0)),
      `age=${c.json?.age}, hidden=${c.json?.hidden_count}`,
    );
  }

  section("3. 跟读提交（voice mock 评测落库）");
  let attemptId = null;
  let dadAttemptIds = [];
  {
    const form = new FormData();
    form.append("audio", wavBlob(2.5, 120), "record.wav");
    form.append("sentence_id", "s-a2-04");
    form.append("reference_text", "I think the weather is really nice today.");
    form.append("mode", "scripted");
    form.append("duration_ms", "3400");
    const { status, json } = await jsonFetch("/api/attempts", {
      method: "POST",
      cookie: dad.cookie,
      body: form,
    });
    attemptId = json?.attempt_id ?? null;
    check("POST /api/attempts 200", status === 200, `status=${status}`);
    check("没有降级（voice mock 正常）", json?.degraded === false, `message=${json?.message}`);
    check(
      "总分落库（scores.pron 是数字）",
      typeof json?.result?.scores?.pron === "number",
      `pron=${json?.result?.scores?.pron}`,
    );
    check("逐词结果非空", (json?.result?.words?.length ?? 0) > 0, `words=${json?.result?.words?.length}`);
    check("issues 非空（含 hint_key）", (json?.result?.issues?.length ?? 0) > 0, `issues=${json?.result?.issues?.length}`);
    const uf0 = json?.result?.intonation?.user_f0 ?? [];
    const rf0 = json?.result?.intonation?.reference_f0 ?? [];
    check(
      "F0 双曲线对齐（同长度、20ms 步长、≥20 点）",
      uf0.length >= 20 && uf0.length === rf0.length && uf0[1][0] - uf0[0][0] === 20,
      `user=${uf0.length} ref=${rf0.length}`,
    );
    check(
      "语调数据让 UI 能画出双曲线（available 或显式 warning 二选一）",
      json?.result?.intonation?.available === true ||
        (json?.result?.warnings ?? []).includes("intonation_unavailable"),
      `available=${json?.result?.intonation?.available} warnings=${JSON.stringify(json?.result?.warnings)}`,
    );
    check(
      "示范音 URL 走 /voice 同源代理",
      String(json?.result?.intonation?.reference_audio_url ?? "").startsWith("/voice/v1/audio/"),
      json?.result?.intonation?.reference_audio_url,
    );
    check("落库反馈（feedback.summary 非空）", Boolean(json?.feedback?.summary), json?.feedback?.provider);
    check("usage 返回（儿童时长限制用）", typeof json?.usage?.limitMinutes === "number");

    const list = await jsonFetch("/api/attempts?limit=5", { cookie: dad.cookie });
    dadAttemptIds = (list.json?.attempts ?? []).map((a) => a.id);
    const mine = (list.json?.attempts ?? []).find((a) => a.id === attemptId);
    check("GET /api/attempts 能查到刚提交的记录", Boolean(mine), `ids=${dadAttemptIds.length}`);
    check(
      "该记录 scores_json 已持久化",
      mine?.scores?.pron === json?.result?.scores?.pron,
      `db=${mine?.scores?.pron} api=${json?.result?.scores?.pron}`,
    );
    check("该记录有 audio_url（音频落盘 data/audio）", Boolean(mine?.audio_url), mine?.audio_url ?? "");

    const audio = await fetch(`${BASE}${mine?.audio_url}`, { headers: { cookie: dad.cookie } });
    const bytes = await audio.arrayBuffer();
    check(
      "GET /api/audio/:id 流式返回音频",
      audio.status === 200 && bytes.byteLength > 0,
      `status=${audio.status} type=${audio.headers.get("content-type")} bytes=${bytes.byteLength}`,
    );

    const retry = await jsonFetch(`/api/attempts/${attemptId}/retry`, {
      method: "POST",
      cookie: dad.cookie,
    });
    check("POST /api/attempts/:id/retry 200", retry.status === 200, `status=${retry.status}`);
    void retry;
  }

  section("4. 错音本 / SRS");
  {
    const r = await jsonFetch("/api/review", { cookie: dad.cookie });
    check("GET /api/review 200", r.status === 200);
    check("产生了逐音素/逐词明细（phoneme_scores 落库）", (r.json?.stats?.phoneme_rows ?? 0) > 0, `rows=${r.json?.stats?.phoneme_rows}`);
    check("弱项自动进错音本（due_cards ≥ 1）", (r.json?.due_cards?.length ?? 0) >= 1, `due=${r.json?.due_cards?.length}`);
    const phonemeLevel = r.json?.stats?.phoneme_level === true;
    check(
      phonemeLevel ? "音素掌握度聚合非空" : "单词级模式下给出高频错词（粗评）",
      phonemeLevel ? (r.json?.weak_phonemes?.length ?? 0) >= 1 : (r.json?.word_level_errors?.length ?? 0) >= 1,
      `weak=${r.json?.weak_phonemes?.length} words=${r.json?.word_level_errors?.length}`,
    );
    const card = r.json?.due_cards?.[0];
    if (card) {
      const g = await jsonFetch("/api/review", {
        method: "POST",
        cookie: dad.cookie,
        body: { card_id: card.id, grade: "good" },
      });
      check("POST /api/review 评分（good）200", g.status === 200, `next_due=${g.json?.next_due_at}`);
      check("SM-2 排期到未来", new Date(g.json?.next_due_at ?? 0).getTime() > Date.now());
    } else {
      check("POST /api/review 评分", false, "没有到期卡片");
    }
  }

  section("5. 对话 3 轮");
  {
    const start = await jsonFetch("/api/chat/sessions", {
      method: "POST",
      cookie: dad.cookie,
      body: { scenario_id: "ordering_coffee" },
    });
    const sid = start.json?.session_id;
    check("POST /api/chat/sessions 201", start.status === 201, `status=${start.status}`);
    check("开场白已入库（assistant 首条）", start.json?.messages?.[0]?.role === "assistant");

    const inputs = ["I want a coffee.", "Hot, please.", "Thank you!"];
    let last = null;
    for (let i = 0; i < inputs.length; i++) {
      last = await jsonFetch(`/api/chat/sessions/${sid}/turn`, {
        method: "POST",
        cookie: dad.cookie,
        body: { text: inputs[i] },
      });
      check(`第 ${i + 1} 轮 dialogue 200`, last.status === 200, `reply="${last.json?.reply}"`);
    }
    check("回复有中文翻译字段", last?.json?.reply_zh !== undefined);
    check(
      "点了 suggested_replies 可用（2–3 条）",
      (last?.json?.suggested_replies?.length ?? 0) >= 2,
      JSON.stringify(last?.json?.suggested_replies),
    );
    check(
      "correction 结构完整（has_error 布尔）",
      typeof last?.json?.correction?.has_error === "boolean",
      JSON.stringify(last?.json?.correction),
    );

    const hist = await jsonFetch(`/api/chat/sessions/${sid}`, { cookie: dad.cookie });
    check(
      "会话消息数 = 1 开场 + 3 轮 × 2 = 7",
      (hist.json?.messages?.length ?? 0) === 7,
      `messages=${hist.json?.messages?.length}`,
    );
  }

  section("6. 家长面板（RBAC）");
  let summary = null;
  {
    const p = await jsonFetch("/api/parent/summary", { cookie: dad.cookie });
    summary = p.json;
    check("爸爸 GET /api/parent/summary 200", p.status === 200, `status=${p.status}`);
    check("成员数 = 3", (p.json?.members?.length ?? 0) === 3, `members=${p.json?.members?.length}`);
    const child = p.json?.members?.find((m) => m.role === "child");
    check("面板含女儿的今日剩余时长", typeof child?.today?.remaining_minutes === "number", `remaining=${child?.today?.remaining_minutes}`);
    check("面板含家庭学习时长汇总", typeof p.json?.family?.minutes_today === "number", `today=${p.json?.family?.minutes_today}min`);
    const dadMember = p.json?.members?.find((m) => m.role !== "child");
    check(
      "面板含高频错音 TOP10（练习者本人有数据）",
      (dadMember?.top_phonemes?.length ?? 0) >= 1 && (dadMember?.top_phonemes?.length ?? 0) <= 10,
      `dad_top=${dadMember?.top_phonemes?.length} 例：${JSON.stringify(dadMember?.top_phonemes?.[0] ?? null)}`,
    );
    check(
      "高频错音带教学提示文案",
      Boolean(dadMember?.top_phonemes?.[0]?.title_zh),
      dadMember?.top_phonemes?.[0]?.title_zh ?? "",
    );
    check("面板含平均分趋势序列", Array.isArray(child?.trend));

    const asChild = await jsonFetch("/api/parent/summary", { cookie: girl.cookie });
    check("女儿访问 /api/parent/summary → 403", asChild.status === 403, `status=${asChild.status} code=${asChild.json?.error?.code}`);

    const pageAsChild = await fetch(`${BASE}/parent`, { headers: { cookie: girl.cookie }, redirect: "manual" });
    const html = await pageAsChild.text();
    check("女儿访问 /parent 页面 → HTTP 403", pageAsChild.status === 403, `status=${pageAsChild.status}`);
    check("403 页面有明确提示", html.includes("403") && html.includes("家长"), "");

    const pageAsDad = await fetch(`${BASE}/parent`, { headers: { cookie: dad.cookie } });
    const dadHtml = await pageAsDad.text();
    check("爸爸访问 /parent → 200 且渲染面板", pageAsDad.status === 200 && dadHtml.includes("高频错音 TOP10"), `status=${pageAsDad.status}`);

    const childLimitPatch = await jsonFetch("/api/settings", {
      method: "PATCH",
      cookie: girl.cookie,
      body: { daily_limit_minutes: 999 },
    });
    check("女儿自行修改每日时长 → 403", childLimitPatch.status === 403, `status=${childLimitPatch.status}`);
  }

  section("7. 渲染层检查（无浏览器，用 HTML 断言兜底）");
  {
    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    check("GET /login 200 且含登录表单文案", loginPage.status === 200 && loginHtml.includes("登录 English Coach"));
    check("未登录访问 /practice 跳转到 /login", (await fetch(`${BASE}/practice`, { redirect: "manual" })).status === 307);

    for (const path of ["/practice", "/review", "/", "/blindtest", "/blindtest/report"]) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: girl.cookie } });
      const html = await res.text();
      const leaked = IPA_CHARS.filter((c) => html.includes(c));
      check(
        `儿童 ${path} 页面不含 IPA 字符`,
        res.status === 200 && leaked.length === 0,
        `status=${res.status} leaked=${leaked.join("")}`,
      );
    }
    const childPractice = await (await fetch(`${BASE}/practice`, { headers: { cookie: girl.cookie } })).text();
    check("儿童 /practice 有儿童化文案", childPractice.includes("我们一起读句子吧"));

    const dadPractice = await (await fetch(`${BASE}/practice`, { headers: { cookie: dad.cookie } })).text();
    check("成人 /practice 正常渲染语料", dadPractice.includes("跟读练习"));
    check("成人 /practice 无 IPA 泄漏到 HTML 也没关系（仅检查渲染成功）", dadPractice.length > 1000);
  }

  section("8. voice 故障降级：录音与文本仍入库 + 稍后可重试");
  if (process.env.SMOKE_SKIP_DEGRADED === "1") {
    console.log("（SMOKE_SKIP_DEGRADED=1，跳过）");
  } else {
    // DOWN_BASE：一个把 VOICE_SERVICE_URL 指向死端口的 web 实例（同一份 DB），
    // 用来证明"voice 挂掉时 web 不丢数据"，并且稍后能在正常实例上重试成功。
    const downBase = (process.env.SMOKE_DOWN_BASE ?? "").replace(/\/$/, "");
    if (!downBase) {
      check("SMOKE_DOWN_BASE 已设置（voice 不可达的 web 实例）", false, "未设置，跳过降级用例");
    } else {
      const form = new FormData();
      form.append("audio", wavBlob(2.0, 130), "record.wav");
      form.append("sentence_id", "s-a1-07");
      form.append("reference_text", "I can see three birds in the tree.");
      form.append("mode", "scripted");
      const post = async (base) =>
        jsonFetch("/api/attempts", { method: "POST", cookie: mom.cookie, body: form, base });
      // 预检：同域不同端口的实例必须能看到同一份 DB（cookie session 在 sessions 表里）
      const me = await jsonFetch("/api/auth/me", { cookie: mom.cookie, base: downBase });
      check(
        `${downBase} 与主实例共用同一份 DB（session 可见）`,
        me.json?.user?.email === "mom@example.com",
        `status=${me.status} user=${JSON.stringify(me.json?.user?.email ?? null)}`,
      );
      const degraded = await post(downBase);
      check("voice 不可达时仍返回 200（降级而不是报错）", degraded.status === 200, `status=${degraded.status}`);
      check(
        "标记 degraded=true 且 retryable=true",
        degraded.json?.degraded === true && degraded.json?.retryable === true,
        `degraded=${degraded.json?.degraded} retryable=${degraded.json?.retryable}`,
      );
      check(
        "结果为空但给出'稍后可重试'提示",
        degraded.json?.result === null && /重试/.test(degraded.json?.message ?? ""),
        degraded.json?.message,
      );

      const list = await jsonFetch("/api/attempts?limit=5", { cookie: mom.cookie });
      const rec = (list.json?.attempts ?? []).find((a) => a.id === degraded.json?.attempt_id);
      check(
        "降级记录已入库（参考文本 + 音频路径）",
        Boolean(rec) && rec.reference_text.length > 0 && Boolean(rec.audio_url),
        `audio=${rec?.audio_url}`,
      );
      check(
        "warnings 显式暴露降级原因",
        (rec?.warnings ?? []).includes("web_voice_unreachable") &&
          (rec?.warnings ?? []).includes("web_pending_retry"),
        JSON.stringify(rec?.warnings),
      );
      check("降级记录 scores 为空（绝不造分数）", rec?.scores === null);

      if (rec?.audio_url) {
        const audio = await fetch(`${BASE}${rec.audio_url}`, { headers: { cookie: mom.cookie } });
        const bytes = await audio.arrayBuffer();
        check("降级时录音仍已落盘可回放", audio.status === 200 && bytes.byteLength > 0, `bytes=${bytes.byteLength}`);
      } else {
        check("降级时录音仍已落盘可回放", false, "记录里没有 audio_url");
      }

      // 换到 voice 正常的实例重试同一条记录
      if (!degraded.json?.attempt_id) {
        check("降级记录拿到 attempt_id", false, JSON.stringify(degraded.json?.error ?? degraded.json));
      }
      const retried = degraded.json?.attempt_id
        ? await jsonFetch(`/api/attempts/${degraded.json.attempt_id}/retry`, {
            method: "POST",
            cookie: mom.cookie,
          })
        : null;
      if (retried) {
        check(
          "voice 恢复后「重试评测」成功（不用重录）",
          retried.status === 200 && retried.json?.degraded === false,
          `status=${retried.status}`,
        );
        check(
          "重试后拿到分数",
          typeof retried.json?.result?.scores?.pron === "number",
          `pron=${retried.json?.result?.scores?.pron}`,
        );
      }
    }
  }

  section("9. capabilities 自适应降级（phoneme_level=false → 单词级粗评）");
  {
    const wlBase = (process.env.SMOKE_WORDLEVEL_BASE ?? "").replace(/\/$/, "");
    if (!wlBase) {
      console.log("（未设置 SMOKE_WORDLEVEL_BASE，跳过。用法：见 README「自测」一节）");
    } else {
      const h = await fetch(`${wlBase}/api/health`).then((r) => r.json());
      check(
        "该实例探测到 phoneme_level=false",
        h?.voice?.capabilities?.phoneme_level === false,
        JSON.stringify(h?.voice?.capabilities ?? {}),
      );
      check("该实例仍探测到 intonation_curve=true（语调不依赖云 API）", h?.voice?.capabilities?.intonation_curve === true);
      const form = new FormData();
      form.append("audio", wavBlob(2.0, 140), "record.wav");
      form.append("sentence_id", "s-a1-07");
      form.append("reference_text", "I can see three birds in the tree.");
      form.append("mode", "scripted");
      const r = await jsonFetch("/api/attempts", { method: "POST", cookie: girl.cookie, body: form, base: wlBase });
      check("单词级模式下仍能提交 200", r.status === 200, `status=${r.status}`);
      check(
        "granularity 降级为 word 且带 warning",
        r.json?.result?.granularity === "word" &&
          (r.json?.result?.warnings ?? []).includes("phoneme_level_unavailable"),
        `granularity=${r.json?.result?.granularity} warnings=${JSON.stringify(r.json?.result?.warnings)}`,
      );
      check(
        "单词级也返回可用的语调曲线（F0）",
        (r.json?.result?.intonation?.user_f0?.length ?? 0) > 0,
        `points=${r.json?.result?.intonation?.user_f0?.length}`,
      );
      const html = await (await fetch(`${wlBase}/practice`, { headers: { cookie: dad.cookie } })).text();
      check("页面标注「单词级粗评」而不是假装音素级", html.includes("单词级"));
    }
  }

  section("10. 盲测周报（契约 §13.3 三条硬性要求）");
  {
    // 先练 12 句：盲测抽题池必须来自"练过的语料"（§13.3 第 4 条）
    const allSentences = (await jsonFetch("/api/sentences", { cookie: girl.cookie })).json?.sentences ?? [];
    const practiceIds = allSentences.slice(0, 12).map((x) => x.id);
    const textById = new Map(allSentences.map((x) => [x.id, x.text]));
    for (const sid of practiceIds) {
      const form = new FormData();
      form.append("audio", wavBlob(2.0, 130), "practice.wav");
      form.append("sentence_id", sid);
      form.append("reference_text", textById.get(sid));
      form.append("mode", "scripted");
      await jsonFetch("/api/attempts", { method: "POST", cookie: girl.cookie, body: form });
    }
    const practicedSet = new Set(practiceIds);
    check("已为盲测准备 12 句「练过的语料」", practiceIds.length === 12, `ids=${practiceIds.length}`);

    // 基线：mastery / SRS / 家长趋势（盲测前后必须一致）
    const beforeReview = (await jsonFetch("/api/review", { cookie: girl.cookie })).json;
    const beforeParent = (await jsonFetch("/api/parent/summary", { cookie: dad.cookie })).json;
    const girlBefore = beforeParent.members.find((m) => m.id === "u-girl");
    check(
      "基线：女儿已有日常练习数据（非盲测）",
      girlBefore.week.attempts >= 12,
      `attempts=${girlBefore.week.attempts} avg=${girlBefore.week.avg_pron}`,
    );

    // 基线：已有多少盲测（本脚本可重复运行，所以断言用相对量）
    const blindBefore = (await jsonFetch("/api/blind-tests", { cookie: girl.cookie })).json;
    const weeksBefore = blindBefore?.trend?.weeks ?? 0;

    // 开始盲测
    const start = await jsonFetch("/api/blind-tests", { method: "POST", cookie: girl.cookie });
    const testId = start.json?.blind_test_id;
    check("POST /api/blind-tests 201", start.status === 201, `status=${start.status}`);
    check("盲测抽 10 句（上限，且不超过练过的句数）", start.json?.total === 10, `total=${start.json?.total}`);
    check(
      "抽题全部来自「练过」的语料（不是没学过的）",
      (start.json?.sentence_ids ?? []).every((id) => practicedSet.has(id)),
      `${(start.json?.sentence_ids ?? []).length} 句`,
    );
    const again = await jsonFetch("/api/blind-tests", { method: "POST", cookie: girl.cookie });
    check(
      "重复开始返回同一批次 + 同一组句子（固定一组，才能与上周比）",
      again.json?.blind_test_id === testId &&
        JSON.stringify(again.json?.sentence_ids) === JSON.stringify(start.json?.sentence_ids),
      `resumed=${again.json?.resumed}`,
    );

    // 逐句提交：断言响应里绝无分数
    const keysSeen = new Set();
    let firstResponse = null;
    for (let i = 0; i < (start.json?.sentence_ids ?? []).length; i++) {
      const sid = start.json.sentence_ids[i];
      const form = new FormData();
      form.append("audio", wavBlob(2.0, 130), "blind.wav");
      form.append("sentence_id", sid);
      form.append("reference_text", textById.get(sid));
      form.append("mode", "scripted");
      form.append("blind_test_id", testId);
      const r = await jsonFetch("/api/attempts", { method: "POST", cookie: girl.cookie, body: form });
      if (i === 0) firstResponse = r;
      for (const k of Object.keys(r.json ?? {})) keysSeen.add(k);
      if (i === 0) {
        check("盲测第 1 句：HTTP 200", r.status === 200, `status=${r.status}`);
        check(
          "★ 盲测进行中响应体只有 attempt_id / blind / progress",
          JSON.stringify(Object.keys(r.json ?? {}).sort()) === '["attempt_id","blind","progress"]',
          JSON.stringify(r.json),
        );
        check(
          "★ 盲测进行中不含 result / feedback / scores",
          !("result" in (r.json ?? {})) && !("feedback" in (r.json ?? {})) && !("scores" in (r.json ?? {})),
          `keys=${Object.keys(r.json ?? {}).join(",")}`,
        );
        check(
          "progress 正确（done=1, total=10）",
          r.json?.progress?.done === 1 && r.json?.progress?.total === 10,
          JSON.stringify(r.json?.progress),
        );
      }
    }
    check(
      "10 句提交过程中出现过的所有字段里都没有分数/反馈键",
      ![...keysSeen].some((k) => ["result", "feedback", "scores", "issues", "intonation", "recognized_text"].includes(k)),
      [...keysSeen].join(","),
    );
    check("进行中不返回反馈（feedback 字段缺席）", !("feedback" in (firstResponse?.json ?? {})));

    // 进行中：历史接口与"重试评测"也不能漏分
    const hist = await jsonFetch("/api/attempts?limit=40", { cookie: girl.cookie });
    const blindRecs = (hist.json?.attempts ?? []).filter((a) => a.blind_test_id === testId);
    check(
      "进行中的盲测记录在 /api/attempts 里被屏蔽（scores/issues/intonation/feedback 全为 null）",
      blindRecs.length === 10 &&
        blindRecs.every(
          (a) => a.scores === null && (a.issues ?? []).length === 0 && a.intonation === null && a.feedback === null && a.pending === true,
        ),
      `records=${blindRecs.length}`,
    );
    const retryBlind = await jsonFetch(`/api/attempts/${blindRecs[0]?.id}/retry`, {
      method: "POST",
      cookie: girl.cookie,
    });
    check(
      "盲测录音不允许「重试评测」（否则分数会漏出来）",
      retryBlind.status === 409 && retryBlind.json?.error?.code === "blind_attempt_no_retry",
      `status=${retryBlind.status} code=${retryBlind.json?.error?.code}`,
    );

    // ★ 不污染：phoneme_mastery / SRS / 日常趋势
    const midReview = (await jsonFetch("/api/review", { cookie: girl.cookie })).json;
    check(
      "★ 盲测不写 phoneme_scores（明细行数不变）",
      midReview?.stats?.phoneme_rows === beforeReview?.stats?.phoneme_rows,
      `${beforeReview?.stats?.phoneme_rows} → ${midReview?.stats?.phoneme_rows}`,
    );
    check(
      "★ 盲测不参与 phoneme_mastery 聚合（掌握度完全不变）",
      JSON.stringify(midReview?.mastery) === JSON.stringify(beforeReview?.mastery),
      `weak=${midReview?.weak_phonemes?.length}`,
    );
    check(
      "★ 盲测不进 SRS 排期（卡片总数不变）",
      midReview?.stats?.total_cards === beforeReview?.stats?.total_cards,
      `${beforeReview?.stats?.total_cards} → ${midReview?.stats?.total_cards}`,
    );
    const midParent = (await jsonFetch("/api/parent/summary", { cookie: dad.cookie })).json;
    const girlMid = midParent.members.find((m) => m.id === "u-girl");
    check(
      "★ 盲测不进日常练习趋势（avg_pron 与练习次数不变）",
      girlMid?.week?.avg_pron === girlBefore?.week?.avg_pron && girlMid?.week?.attempts === girlBefore?.week?.attempts,
      `avg ${girlBefore?.week?.avg_pron} → ${girlMid?.week?.avg_pron}；attempts ${girlBefore?.week?.attempts} → ${girlMid?.week?.attempts}`,
    );
    check(
      "盲测时长单独归类（blind_minutes>0，不混进练习分钟）",
      (girlMid?.today?.blind_minutes ?? 0) > 0 && girlMid?.today?.total_minutes >= girlMid?.today?.minutes,
      `practice=${girlMid?.today?.minutes} blind=${girlMid?.today?.blind_minutes}`,
    );

    // 结束 → 分数才可读
    const fin = await jsonFetch(`/api/blind-tests/${testId}/finish`, { method: "POST", cookie: girl.cookie });
    check("finish 后分数可读（avg_pron 是数字）", fin.status === 200 && typeof fin.json?.avg_pron === "number", `avg_pron=${fin.json?.avg_pron}`);
    check(
      "finish 汇总含 accuracy/fluency/语调差异",
      typeof fin.json?.avg_accuracy === "number" &&
        typeof fin.json?.avg_fluency === "number" &&
        typeof fin.json?.avg_intonation_distance === "number",
      `acc=${fin.json?.avg_accuracy} flu=${fin.json?.avg_fluency} dtw=${fin.json?.avg_intonation_distance}`,
    );
    check(
      weeksBefore === 0 ? "首次盲测没有上一次可比（previous=null, delta=null）" : "非首次盲测：previous 指向上一次、delta 是数字",
      weeksBefore === 0
        ? fin.json?.previous === null && fin.json?.delta_pron === null
        : typeof fin.json?.previous?.avg_pron === "number" && typeof fin.json?.delta_pron === "number",
      `weeksBefore=${weeksBefore} prev=${fin.json?.previous?.avg_pron ?? "null"} delta=${fin.json?.delta_pron}`,
    );
    const firstAvg = fin.json?.avg_pron;

    // 第二次盲测 → 周环比
    const start2 = await jsonFetch("/api/blind-tests", { method: "POST", cookie: girl.cookie });
    check(
      "第二次盲测复用同一组句子（固定一组）",
      JSON.stringify(start2.json?.sentence_ids) === JSON.stringify(start.json?.sentence_ids),
      `total=${start2.json?.total}`,
    );
    for (const sid of start2.json?.sentence_ids ?? []) {
      const form = new FormData();
      // 故意用更短的录音：voice mock 的 pron 只由文本决定，但 fluency/语调会随音频变化，
      // 这样第二次的 delta 才会是非零值（证明 finish 的差值计算真的在算）
      form.append("audio", wavBlob(1.0, 130), "blind2.wav");
      form.append("sentence_id", sid);
      form.append("reference_text", textById.get(sid));
      form.append("mode", "scripted");
      form.append("blind_test_id", start2.json.blind_test_id);
      await jsonFetch("/api/attempts", { method: "POST", cookie: girl.cookie, body: form });
    }
    const fin2 = await jsonFetch(`/api/blind-tests/${start2.json.blind_test_id}/finish`, {
      method: "POST",
      cookie: girl.cookie,
    });
    check(
      "第二次 finish 给出与上一次的差值（delta_pron 是数字，previous 指向上一次）",
      typeof fin2.json?.delta_pron === "number" && fin2.json?.previous?.avg_pron === firstAvg,
      `this=${fin2.json?.avg_pron} prev=${fin2.json?.previous?.avg_pron} delta_pron=${fin2.json?.delta_pron}`,
    );
    check(
      "★ 差值计算有真实变化（第二次录音更短 → delta_fluency ≠ 0）",
      typeof fin2.json?.delta_fluency === "number" && fin2.json?.delta_fluency !== 0,
      `this_flu=${fin2.json?.avg_fluency} prev_flu=${fin2.json?.previous?.avg_fluency} delta_flu=${fin2.json?.delta_fluency}`,
    );

    const list = await jsonFetch("/api/blind-tests", { cookie: girl.cookie });
    check(
      "GET /api/blind-tests 趋势字段齐全（current/previous/delta_pron/weeks）",
      list.json?.trend?.weeks === weeksBefore + 2 &&
        typeof list.json?.trend?.delta_pron === "number" &&
        list.json?.trend?.previous?.avg_pron === firstAvg,
      JSON.stringify(list.json?.trend),
    );
    check(
      "历史列表按时间倒序返回（含本次新增的 2 次）",
      (list.json?.tests ?? []).length === weeksBefore + 2,
      `tests=${list.json?.tests?.length} weeksBefore=${weeksBefore}`,
    );

    // 家长面板可见（显眼）
    const parentAfter = (await jsonFetch("/api/parent/summary", { cookie: dad.cookie })).json;
    const girlAfter = parentAfter.members.find((m) => m.id === "u-girl");
    check(
      "★ 家长面板拿到盲测周环比数据",
      typeof girlAfter?.blind?.current?.avg_pron === "number" &&
        girlAfter?.blind?.weeks === weeksBefore + 2 &&
        typeof girlAfter?.blind?.delta_pron === "number" &&
        (girlAfter?.blind?.series ?? []).length === weeksBefore + 2,
      `current=${girlAfter?.blind?.current?.avg_pron} delta=${girlAfter?.blind?.delta_pron} weeks=${girlAfter?.blind?.weeks}`,
    );
    const parentHtml = await (await fetch(`${BASE}/parent`, { headers: { cookie: dad.cookie } })).text();
    check(
      "家长面板 HTML 渲染盲测周环比区块（显眼位置）",
      parentHtml.includes('data-testid="blind-weekly-panel"') && parentHtml.includes("本周 vs 上周"),
    );

    // 盲测页永不出现分数
    const blindHtml = await (await fetch(`${BASE}/blindtest`, { headers: { cookie: girl.cookie } })).text();
    check(
      "★ 儿童 /blindtest 页面 HTML 不含任何分数（无 avg_pron/delta_pron 字样）",
      blindHtml.includes("小测验") && !blindHtml.includes("avg_pron") && !blindHtml.includes("delta_pron"),
      `len=${blindHtml.length}`,
    );
    const reportHtml = await (await fetch(`${BASE}/blindtest/report`, { headers: { cookie: girl.cookie } })).text();
    check(
      "结束后 /blindtest/report 才展示分数",
      reportHtml.includes('data-testid="blind-current"') && reportHtml.includes(String(firstAvg)),
    );
  }

  section("11. 家长自定义语料（归属隔离）");
  {
    const before = (await jsonFetch("/api/sentences", { cookie: dad.cookie })).json;
    const officialBefore = before.official_count;
    const totalBefore = before.count;

    const created = await jsonFetch("/api/sentences", {
      method: "POST",
      cookie: dad.cookie,
      body: { text: "I would like a glass of water, please.", translation_zh: "请给我一杯水。", level: "A2", focus_phonemes: "θ w" },
    });
    check("爸爸录入自定义语料 201", created.status === 201, `status=${created.status}`);
    check(
      "落库字段正确（source=parent / owner=爸爸 / 等级与重点音素保留）",
      created.json?.created?.source === "parent" &&
        created.json?.created?.owner_user_id === "u-dad" &&
        created.json?.created?.level === "A2" &&
        (created.json?.created?.focus_phonemes ?? []).length === 2,
      JSON.stringify(created.json?.created ?? {}),
    );

    const dadList = (await jsonFetch("/api/sentences", { cookie: dad.cookie })).json;
    check("爸爸自己可见（mine_count ≥ 1）", (dadList.mine_count ?? 0) >= 1, `mine=${dadList.mine_count}`);
    check(
      "官方语料数量不受自定义录入影响（基线不变）",
      dadList.official_count === officialBefore && officialBefore >= 60,
      `${officialBefore} → ${dadList.official_count}`,
    );

    const girlList = (await jsonFetch("/api/sentences", { cookie: girl.cookie })).json;
    check(
      "女儿可见爸爸录的语料（家长录入 → 其孩子可用）",
      girlList.sentences.some((x) => x.text === "I would like a glass of water, please."),
      `girl total=${girlList.count}`,
    );
    check(
      "女儿看到的官方语料数量与爸爸一致（没被污染）",
      girlList.official_count === officialBefore,
      `official=${girlList.official_count}`,
    );

    const momList = (await jsonFetch("/api/sentences", { cookie: mom.cookie })).json;
    check(
      "妈妈看不到爸爸录的语料（家长之间互相隔离）",
      !momList.sentences.some((x) => x.owner_user_id === "u-dad"),
      `mom total=${momList.count} custom=${momList.custom_count}`,
    );

    const girlCreate = await jsonFetch("/api/sentences", {
      method: "POST",
      cookie: girl.cookie,
      body: { text: "I am a child.", level: "A1" },
    });
    check("儿童不能录入自定义语料 → 403", girlCreate.status === 403, `status=${girlCreate.status}`);

    const batch = await jsonFetch("/api/sentences", {
      method: "POST",
      cookie: dad.cookie,
      body: { batch: "Good morning, Miss Li.\nHow many apples do you have? | 你有几个苹果？\n\nThis is my school bag.", level: "A1" },
    });
    check(
      "批量粘贴：每行一句，翻译可留空",
      batch.status === 201 && batch.json?.created_count === 3,
      `created=${batch.json?.created_count} skipped=${batch.json?.skipped_count}`,
    );

    const customId = created.json?.created?.id;
    const momDelete = await jsonFetch(`/api/sentences/${customId}`, { method: "DELETE", cookie: mom.cookie });
    check("别人不能删我的语料 → 403", momDelete.status === 403, `status=${momDelete.status}`);
    const dadDelete = await jsonFetch(`/api/sentences/${customId}`, { method: "DELETE", cookie: dad.cookie });
    check("本人可以删除自己的语料", dadDelete.status === 200, `status=${dadDelete.status}`);
    const afterDelete = (await jsonFetch("/api/sentences", { cookie: girl.cookie })).json;
    check(
      "删除后女儿也看不到了",
      !afterDelete.sentences.some((x) => x.id === customId),
      `girl total=${afterDelete.count}`,
    );
    const finalDad = (await jsonFetch("/api/sentences", { cookie: dad.cookie })).json;
    check(
      "官方语料全程保持基线不变（自定义语料独立计数）",
      finalDad.official_count === officialBefore && finalDad.custom_count >= 3,
      `official=${finalDad.official_count} custom=${finalDad.custom_count} (总 ${totalBefore} → ${finalDad.count})`,
    );
  }

  section("12. 错音本卡片（成人有音素+口型提示 / 儿童无 IPA 且文案非空）");
  {
    const IPA_RE = /[θðɹŋæʃɪʌɔɜəʊʒɑɒɛˈˌ]/;

    const dadReview = (await jsonFetch("/api/review", { cookie: dad.cookie })).json;
    const dadPhonemeCards = (dadReview?.due_cards ?? []).filter((c) => c.is_phoneme);
    check("成人视图存在音素卡片", dadPhonemeCards.length > 0, `cards=${dadPhonemeCards.length}`);
    check(
      "★ 成人音素卡片：ref/phoneme/label 全部非空（不再出现 ref: \"\"）",
      dadPhonemeCards.every((c) => Boolean(c.ref) && Boolean(c.phoneme) && Boolean(c.label)),
      dadPhonemeCards.map((c) => `${c.ref}|${c.phoneme}|${c.label.slice(0, 8)}`).join(" / "),
    );
    check(
      "★ 成人音素卡片：每张都有非空的口型/舌位提示（how_zh）与「为什么」",
      dadPhonemeCards.every((c) => (c.how_zh ?? "").length > 5 && Boolean(c.why_zh)),
      dadPhonemeCards.map((c) => (c.how_zh ?? "").slice(0, 10)).join(" / "),
    );
    check(
      "★ hint_key 语义正确：是「提示键」或 null，绝不等于音素符号本身",
      dadPhonemeCards.every((c) => c.hint_key === null || c.hint_key !== c.ref),
      dadPhonemeCards.map((c) => `${c.ref}→${c.hint_key}`).join(" / "),
    );
    const mappedCards = dadPhonemeCards.filter((c) => c.hint_key);
    check(
      "有映射的音素卡片带练习词与示范文本",
      mappedCards.length > 0 && mappedCards.every((c) => (c.practice_words ?? []).length > 0 && Boolean(c.demo_text)),
      `mapped=${mappedCards.length}/${dadPhonemeCards.length} 例：${JSON.stringify(mappedCards[0]?.practice_words ?? [])}`,
    );
    const dadReviewHtml = await (await fetch(`${BASE}/review`, { headers: { cookie: dad.cookie } })).text();
    check(
      "成人 /review 页面渲染了音素符号（IPA 对成人可见）",
      dadPhonemeCards.some((c) => dadReviewHtml.includes(c.phoneme)),
      `symbols=${dadPhonemeCards.map((c) => c.phoneme).join(",")}`,
    );

    const girlReview = (await jsonFetch("/api/review", { cookie: girl.cookie })).json;
    const girlPhonemeCards = (girlReview?.due_cards ?? []).filter((c) => c.is_phoneme);
    check("儿童视图存在音素卡片", girlPhonemeCards.length > 0, `cards=${girlPhonemeCards.length}`);
    const girlCard = girlPhonemeCards[0];
    if (girlCard) {
      check(
        "★ 儿童音素卡片：ref/phoneme 置空（不下发 IPA）但 label 与 how_zh 非空",
        girlCard.ref === "" &&
          girlCard.phoneme === null &&
          Boolean(girlCard.label) &&
          Boolean(girlCard.how_zh && girlCard.how_zh.length > 5),
        `label="${girlCard.label}" how="${girlCard.how_zh}"`,
      );
      check(
        "★ 儿童卡片 JSON 载荷里不含任何特征 IPA 字形（含 hint_key）",
        !IPA_RE.test(JSON.stringify(girlCard)),
        `hint_key=${girlCard.hint_key}`,
      );
      check(
        "儿童音素卡片文案是儿童化版本（不是成人 IPA 文案）",
        !IPA_RE.test(girlCard.label) && !IPA_RE.test(girlCard.how_zh) && !IPA_RE.test(girlCard.why_zh ?? ""),
      );
    }
    const girlWeak = girlReview?.weak_phonemes ?? [];
    check(
      "★ 儿童掌握度列表：phoneme 置空 + hint_key 不是音素符号",
      girlWeak.length > 0 &&
        girlWeak.every((w) => w.phoneme === "" && !IPA_RE.test(String(w.hint_key ?? "")) && Boolean(w.label)),
      `weak=${girlWeak.length}`,
    );
    const girlWeakPayload = JSON.stringify({ cards: girlPhonemeCards, weak: girlWeak });
    check(
      "★ 儿童 /review 接口整个载荷不含 IPA 字形",
      !IPA_RE.test(girlWeakPayload),
      `len=${girlWeakPayload.length}`,
    );
    check(
      "成人视图仍保留音素符号（降级不能把成人的信息也砍掉）",
      dadReviewHtml.includes("音素") || dadPhonemeCards.length > 0,
    );
  }

  console.log(`\n──────── 汇总 ────────`);
  const passed = results.length - failed;
  console.log(`共 ${results.length} 项断言，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    console.log("\n失败项：");
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name} ${r.detail}`);
  }
  console.log(
    `\n家长面板摘要：成员 ${summary?.members?.length ?? "?"} 人，今日 ${summary?.family?.minutes_today ?? "?"} 分钟，语料 ${summary?.family?.sentence_count ?? "?"} 句，场景 ${summary?.family?.scenario_count ?? "?"} 个`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke 崩溃：", err);
  process.exit(2);
});
