"use client";

import { useMemo, useState } from "react";
import { VOICE_OPTIONS, voiceOption } from "@/lib/voices";

interface SettingsUser {
  displayName: string;
  email: string;
  role: string;
  ageBand: string;
  cefrLevel: string;
  dailyLimitMinutes: number;
  allowFreeChat: boolean;
  isChild: boolean;
  /** task-76：卡通插画自动生成（默认关） */
  autoIllustrate: boolean;
  /** task-76：性别（插画提示词用） */
  gender: string | null;
  /** task-81：故事句子数（null = 角色默认） */
  storySentences?: number | null;
}

export function SettingsForm({
  user,
  prefs,
  usage,
  imageConfigured = false,
}: {
  user: SettingsUser;
  prefs: { correctionLevel: string; ttsVoice: string | null; ttsRate: string };
  usage: { minutes: number; limitMinutes: number; remainingMinutes: number };
  /** voice 侧是否配置了图像服务（task-76：开关旁边展示） */
  imageConfigured?: boolean;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [limit, setLimit] = useState(user.dailyLimitMinutes);
  const [allowFreeChat, setAllowFreeChat] = useState(user.allowFreeChat);
  const [correctionLevel, setCorrectionLevel] = useState(prefs.correctionLevel);
  const [ttsVoice, setTtsVoice] = useState(prefs.ttsVoice ?? "");
  const [ttsRate, setTtsRate] = useState(prefs.ttsRate);
  const [autoIllustrate, setAutoIllustrate] = useState(user.autoIllustrate);
  const [gender, setGender] = useState(user.gender ?? "");
  const roleDefault = user.isChild ? 5 : 8;
  const [storySentences, setStorySentences] = useState<number | null>(user.storySentences ?? null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 音色试听（task-76 ③）：GET /api/tts?text=…&voice=… 直接给 <audio> 播 */
  async function previewVoice() {
    const voice = ttsVoice || VOICE_OPTIONS[0].id;
    const opt = voiceOption(voice);
    const text = opt?.sample ?? "Hello! Let's practice English together.";
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const url = `/api/tts?${new URLSearchParams({ text, rate: "normal", format: "mp3", voice }).toString()}`;
      const audio = new Audio(url);
      await audio.play().catch((err) => {
        throw new Error(`浏览器没让播放（${(err as Error).message}），点播放器再试`);
      });
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  }

  const voiceGroups = useMemo(
    () => ({
      en: VOICE_OPTIONS.filter((v) => v.lang === "en"),
      zh: VOICE_OPTIONS.filter((v) => v.lang === "zh"),
    }),
    [],
  );

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        display_name: displayName,
        correction_level: correctionLevel,
        tts_voice: ttsVoice || null,
        tts_rate: ttsRate,
        auto_illustrate: autoIllustrate,
        gender: gender || null,
        story_sentences: storySentences,
      };
      if (!user.isChild) {
        payload.daily_limit_minutes = limit;
        payload.allow_free_chat = allowFreeChat;
      }
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(data?.error?.message ?? "保存失败");
        return;
      }
      setMessage("已保存 ✅");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">⚙️ 设置</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          {user.email} · {user.role === "parent" ? "家长" : "儿童"} · 等级 {user.cefrLevel} · 今日已练{" "}
          {usage.minutes}/{usage.limitMinutes} 分钟
        </p>
      </section>

      <section className="ec-card flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          昵称
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          />
        </label>

        {user.isChild ? (
          <p className="rounded-xl bg-[#f8f9ff] p-3 text-sm text-[var(--ec-muted)]">
            🧒 儿童账号的「每日时长上限」和「自由话题开关」由家长在家长账号里设置（服务端会拒绝儿童自行修改）。
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium">
              每日练习时长上限：{limit} 分钟
              <input
                type="range"
                min={5}
                max={120}
                step={5}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={allowFreeChat}
                onChange={(e) => setAllowFreeChat(e.target.checked)}
              />
              允许自由话题（关闭后对话强制 child_safe 安全模式）
            </label>
          </>
        )}

        {/* task-76 ①：卡通插画自动生成开关（默认关，避免自动花钱） */}
        <div className="rounded-xl bg-[#f8f9ff] p-3" data-testid="auto-illustrate-section">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              data-testid="auto-illustrate-toggle"
              checked={autoIllustrate}
              onChange={(e) => setAutoIllustrate(e.target.checked)}
            />
            🎨 {user.isChild ? "要不要自动画一张画？" : "卡通插画自动生成"}
          </label>
          <p className="mt-1 text-xs text-[var(--ec-muted)]">
            每张约 ¥0.1；关闭后保存故事不会自动画，仍可在故事页手动点「生成插画」。
            当前图像服务：<strong>{imageConfigured ? "已配置" : "未配置（生成会给出可读提示）"}</strong>
          </p>
        </div>

        {/* task-76 ②：性别（影响插画里的形象，避免都画成男孩） */}
        <label className="flex flex-col gap-1 text-sm font-medium">
          {user.isChild ? "你是男孩还是女孩？" : "性别（影响插画里的形象）"}
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            data-testid="gender-select"
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          >
            <option value="">不设置（插画里用中性形象）</option>
            <option value="girl">女孩（girl）</option>
            <option value="boy">男孩（boy）</option>
            <option value="woman">成年女性（woman）</option>
            <option value="man">成年男性（man）</option>
            <option value="other">其它 / 不想说（other）</option>
          </select>
          <span className="text-xs font-normal text-[var(--ec-muted)]">
            只用于插画提示词与形象筛选，不会展示给其他人。
          </span>
        </label>

        {/* task-81：故事句子数（账号默认） */}
        <div className="rounded-xl bg-[#f8f9ff] p-3" data-testid="story-sentences-section">
          <p className="text-sm font-semibold">📖 故事句子数（默认 {storySentences ?? roleDefault} 句{storySentences === null ? "，角色默认" : ""}）</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {Array.from({ length: 10 }, (_, i) => i + 3).map((n) => (
              <button
                key={n}
                type="button"
                data-testid={`story-sentences-${n}`}
                aria-pressed={(storySentences ?? roleDefault) === n}
                onClick={() => setStorySentences(n)}
                className={`ec-btn !px-2 !py-0.5 text-xs ${(storySentences ?? roleDefault) === n ? "ec-btn-primary" : "ec-btn-ghost"}`}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              data-testid="story-sentences-reset"
              className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
              onClick={() => setStorySentences(null)}
            >
              恢复默认（{roleDefault}）
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--ec-muted)]">
            句子越多故事越长；家长默认 8 句，孩子默认 5 句（可选 3–12）。故事页里临时改只影响那一次。
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium">
          纠正强度（correction_level）
          <select
            value={correctionLevel}
            onChange={(e) => setCorrectionLevel(e.target.value)}
            className="rounded-xl border border-[#d9dcf0] px-3 py-2"
          >
            <option value="gentle">gentle · 只纠 1 处，语气轻</option>
            <option value="standard">standard · 正常纠正</option>
            <option value="none">none · 纯聊天不纠错</option>
          </select>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1 text-sm font-medium" data-testid="tts-voice-options">
            <span>🔊 音色（练习示范音、对话朗读、鼓励音都会用它）</span>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              data-testid="tts-voice-select"
              className="rounded-xl border border-[#d9dcf0] px-3 py-2"
            >
              <option value="">默认音色（provider 决定）</option>
              <optgroup label="英语">
                {voiceGroups.en.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label_zh}
                  </option>
                ))}
              </optgroup>
              <optgroup label="中文">
                {voiceGroups.zh.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label_zh}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
                data-testid="tts-voice-preview"
                disabled={previewBusy}
                onClick={() => void previewVoice()}
              >
                {previewBusy ? "试听中…" : "▶ 试听这个音色"}
              </button>
              <span className="text-xs font-normal text-[var(--ec-muted)]">
                {voiceOption(ttsVoice)?.sample ?? "选中后点试听，会读一句示例。"}
              </span>
            </div>
            {previewError ? (
              <p className="text-xs text-red-700" role="alert" data-testid="tts-voice-preview-error">
                {previewError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1 text-sm font-medium" data-testid="tts-rate-options">
            <span>朗读语速（示范音 / 对话朗读 / 跟读回放都生效）</span>
            {/* 儿童用大按钮两选一（小下拉手指不好点），成人保留下拉 */}
            {user.isChild ? (
              <div className="mt-1 flex flex-wrap gap-3">
                <button
                  type="button"
                  data-testid="tts-rate-slow"
                  data-rate="slow"
                  aria-pressed={ttsRate === "slow"}
                  aria-label="把朗读语速设为慢速"
                  onClick={() => setTtsRate("slow")}
                  className={`ec-btn ${ttsRate === "slow" ? "ec-btn-primary" : "ec-btn-ghost"}`}
                >
                  🐢 慢速（听清楚）
                </button>
                <button
                  type="button"
                  data-testid="tts-rate-normal"
                  data-rate="normal"
                  aria-pressed={ttsRate === "normal"}
                  aria-label="把朗读语速设为正常"
                  onClick={() => setTtsRate("normal")}
                  className={`ec-btn ${ttsRate === "normal" ? "ec-btn-primary" : "ec-btn-ghost"}`}
                >
                  🐇 正常（快一点）
                </button>
              </div>
            ) : (
              <select
                value={ttsRate}
                onChange={(e) => setTtsRate(e.target.value)}
                className="rounded-xl border border-[#d9dcf0] px-3 py-2"
                data-testid="tts-rate-select"
              >
                <option value="normal">normal（正常）</option>
                <option value="slow">slow（慢速，教学）</option>
              </select>
            )}
            <span className="mt-1 text-xs font-normal text-[var(--ec-muted)]">
              慢速更清楚，但合成耗时约为正常语速的 <strong>2.3 倍</strong>（等待更久）；测过：已经预热过的句子是秒出。
            </span>
          </div>
        </div>

        {message ? <p className="ec-pop text-sm font-semibold text-[var(--ec-good)]">{message}</p> : null}
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <div>
          <button type="button" className="ec-btn ec-btn-primary" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存设置"}
          </button>
        </div>
      </section>
    </div>
  );
}
