"use client";

import { useState } from "react";

interface SettingsUser {
  displayName: string;
  email: string;
  role: string;
  ageBand: string;
  cefrLevel: string;
  dailyLimitMinutes: number;
  allowFreeChat: boolean;
  isChild: boolean;
}

export function SettingsForm({
  user,
  prefs,
  usage,
}: {
  user: SettingsUser;
  prefs: { correctionLevel: string; ttsVoice: string | null; ttsRate: string };
  usage: { minutes: number; limitMinutes: number; remainingMinutes: number };
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [limit, setLimit] = useState(user.dailyLimitMinutes);
  const [allowFreeChat, setAllowFreeChat] = useState(user.allowFreeChat);
  const [correctionLevel, setCorrectionLevel] = useState(prefs.correctionLevel);
  const [ttsVoice, setTtsVoice] = useState(prefs.ttsVoice ?? "");
  const [ttsRate, setTtsRate] = useState(prefs.ttsRate);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <label className="flex flex-col gap-1 text-sm font-medium">
            音色（tts_voice，可留空用 provider 默认）
            <input
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder="en-US-JennyNeural"
              className="rounded-xl border border-[#d9dcf0] px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            示范音语速
            <select
              value={ttsRate}
              onChange={(e) => setTtsRate(e.target.value)}
              className="rounded-xl border border-[#d9dcf0] px-3 py-2"
            >
              <option value="normal">normal</option>
              <option value="slow">slow（慢速，教学）</option>
            </select>
          </label>
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
