"use client";

import { useEffect, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
import { ReplayButton } from "@/components/ReplayButton";
import { clearSpeechCache, disposeSpeech, speak, stopSpeech, type SpeechRate } from "@/lib/speech-player";
import type { DialogueCorrection } from "@/lib/types";

interface ScenarioItem {
  id: string;
  title: string;
  title_zh: string;
  setting_zh: string;
  opening_line: string;
  level: string;
  min_age: number;
  tags: string[];
}

interface Message {
  role: "user" | "assistant";
  text: string;
  text_zh?: string | null;
  correction?: DialogueCorrection | null;
  flag?: string | null;
}

interface Usage {
  minutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  exceeded: boolean;
}

interface TurnResponse {
  reply: string;
  reply_zh: string | null;
  correction: DialogueCorrection;
  suggested_replies: string[];
  target_words: string[];
  flag: string;
  done: boolean;
  degraded?: boolean;
  degraded_llm?: boolean;
  error?: { message?: string };
}

export function ChatClient({
  isChild,
  age,
  scenarios,
  hiddenCount,
  usage: initialUsage,
  voiceReachable,
}: {
  isChild: boolean;
  age: number;
  scenarios: ScenarioItem[];
  hiddenCount: number;
  usage: Usage;
  voiceReachable: boolean;
}) {
  const [active, setActive] = useState<ScenarioItem | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [degraded, setDegraded] = useState(false);
  // v1.4 §6：本条回复是否由「固定话术」生成（未接入大模型）
  const [degradedLlm, setDegradedLlm] = useState(false);
  const [usage, setUsage] = useState(initialUsage);
  const [done, setDone] = useState(false);
  // 儿童默认展开语音输入：孩子不用找按钮（task-18 #10）
  const [showMic, setShowMic] = useState(isChild);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // ── 语音朗读（task-18）────────────────────────────────────────────────────
  const [autoRead, setAutoRead] = useState(true); // 儿童/成人默认都开，可手动关
  const [speechBlocked, setSpeechBlocked] = useState(false);
  /** 正在准备/正在说话（TTS 合成可能要 1–11s，必须让用户看到进度） */
  const [speechStatus, setSpeechStatus] = useState<{ index: number; phase: "preparing" | "speaking" } | null>(
    null,
  );
  /** 这一条 TTS 超时/失败 → 把重播按钮变成显眼的「重试播放」 */
  const [slowIndex, setSlowIndex] = useState<number | null>(null);
  const lastSpokenRef = useRef<{ index: number; text: string } | null>(null);
  const speechRate: SpeechRate = isChild ? "slow" : "normal";

  /** 朗读某条 assistant 消息：先渲染文字，这里只负责"异步补上声音" */
  async function readAssistant(index: number, text: string) {
    lastSpokenRef.current = { index, text };
    if (!autoRead) return;
    // 文字已经渲染；这里只是异步补声音。用户可以立刻继续打字/说话，不阻塞下一轮。
    setSpeechStatus({ index, phase: "preparing" });
    setSlowIndex(null);
    const outcome = await speak(text, speechRate, {
      format: "mp3", // 聊天回复每次都是新文本（必 miss）→ mp3 更小更快；练习页示范音仍走 wav 共用预热缓存
      timeoutMs: 6000, // 超过 6s 直接放弃等待，交给「重试播放」
      onMeta: (m) =>
        console.info(`[chat-speech] provider=${m.provider ?? "-"} duration=${m.durationMs ?? "-"} format=${m.format}`),
      onEnd: () => {
        setSpeechStatus((cur) => (cur?.index === index ? null : cur));
      },
    });
    if (outcome === "played") {
      setSpeechStatus({ index, phase: "speaking" });
      return;
    }
    setSpeechStatus(null);
    if (outcome === "blocked") setSpeechBlocked(true);
    if (outcome === "timeout" || outcome === "failed") setSlowIndex(index);
  }

  /** 用户点一次解锁自动播放（浏览器要求用户手势） */
  async function unlockSpeech() {
    setSpeechBlocked(false);
    setAutoRead(true);
    const last = lastSpokenRef.current;
    if (last) await readAssistant(last.index, last.text);
  }

  // 卸载：停止播放 + 释放所有 object URL
  useEffect(() => {
    return () => disposeSpeech();
  }, []);

  /** 统一"停掉声音 + 清状态"（切场景、关闭开关、新一轮发言都走这里） */
  function silence() {
    stopSpeech();
    setSpeechStatus(null);
    setSlowIndex(null);
  }

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function start(scenario: ScenarioItem) {
    // 切场景：停掉正在播的、清空 object URL 缓存（任务要求 #13）
    clearSpeechCache();
    setSpeechBlocked(false);
    silence();
    setBusy(true);
    setError(null);
    setLimitMessage(null);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario_id: scenario.id }),
      });
      const data = (await res.json()) as {
        session_id?: string;
        messages?: { role: "assistant"; text: string; text_zh: string | null }[];
        error?: { message?: string };
      };
      if (res.status === 429) {
        setLimitMessage(data?.error?.message ?? "今天的练习时间到啦 🌙");
        return;
      }
      if (!res.ok || !data.session_id) {
        setError(data?.error?.message ?? "开始会话失败");
        return;
      }
      setActive(scenario);
      setSessionId(data.session_id);
      setMessages(
        (data.messages ?? []).map((m) => ({
          role: m.role,
          text: m.text,
          text_zh: m.text_zh,
        })),
      );
      setSuggestions([]);
      setDone(false);
      setDegraded(false);
      // 开场白也朗读（这次点击本身就是用户手势，最容易通过自动播放策略）
      const opening = data.messages?.[0]?.text ?? scenario.opening_line;
      void readAssistant(0, opening);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string) {
    if (!sessionId || !text.trim()) return;
    // 新的一轮开始：先停止上一条朗读，避免与"正在等的回复"叠音（不阻塞输入）
    silence();
    setBusy(true);
    setError(null);
    setInput("");
    const assistantIndex = messages.length + 1; // 用户消息后的那条
    setMessages((prev) => [...prev, { role: "user", text }]);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as TurnResponse;
      if (res.status === 429) {
        setLimitMessage(data?.error?.message ?? "今天的练习时间到啦 🌙");
        return;
      }
      if (!res.ok) {
        setError(data?.error?.message ?? "发送失败");
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply,
          text_zh: data.reply_zh,
          correction: data.correction,
          flag: data.flag,
        },
      ]);
      setSuggestions(data.suggested_replies ?? []);
      setDone(Boolean(data.done));
      setDegraded(Boolean(data.degraded));
      setDegradedLlm(data.degraded_llm === true);
      setUsage((u) => ({ ...u, minutes: Math.round((u.minutes + 0.5) * 10) / 10 }));
      // 文字已经渲染（上面的 setMessages），这里再异步补声音，绝不阻塞消息出现
      void readAssistant(assistantIndex, data.reply);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function voiceToText(blob: Blob) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      const res = await fetch("/api/asr", { method: "POST", body: form });
      const data = (await res.json()) as { text?: string; error?: { message?: string } };
      if (!res.ok || !data.text) {
        setError(data?.error?.message ?? "没听清，再试一次或直接打字");
        return;
      }
      await send(data.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">{isChild ? "💬 和我聊聊天吧！" : "💬 对话训练"}</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          {isChild
            ? `你 ${age} 岁，这里只显示适合你的场景。`
            : `共 ${scenarios.length} 个场景（儿童可见场景另有 ${hiddenCount} 个被年龄过滤）。`}
          {isChild ? " 不会的词可以点下面的句子直接说。" : ""}
        </p>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          今日已练 {usage.minutes}/{usage.limitMinutes} 分钟
          {isChild ? ` · 还剩 ${usage.remainingMinutes} 分钟` : ""}
          {voiceReachable ? "" : " · 语音识别未就绪，仍可直接打字"}
          {isChild ? " · 儿童安全模式：服务端强制过滤不当内容" : ""}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="autoread-toggle"
            aria-pressed={autoRead}
            aria-label={autoRead ? "关闭自动朗读" : "开启自动朗读"}
            onClick={() => {
              const next = !autoRead;
              setAutoRead(next);
              if (!next) silence();
            }}
            className={`ec-btn ${autoRead ? "ec-btn-primary" : "ec-btn-ghost"}`}
          >
            {autoRead ? "🔊 自动朗读：开" : "🔇 自动朗读：关"}
          </button>
          <span className="text-xs text-[var(--ec-muted)]">
            每条回复会自动读出来（{isChild ? "慢速" : "正常语速"}）。语音合成最长可能要几秒，
            期间消息旁会显示「正在准备语音…」，等不及也可以点消息里的「🔊 重播 / 重试播放」。
          </span>
        </div>

        {speechBlocked ? (
          <button
            type="button"
            data-testid="speech-unlock"
            aria-label="点这里开启朗读"
            onClick={unlockSpeech}
            className="ec-pop mt-2 block w-full rounded-xl bg-[#fff3d6] p-3 text-left text-sm"
          >
            🔇 浏览器拦截了自动播放 —— <strong>点这里开启朗读</strong>（只需点一次）
          </button>
        ) : null}

        {limitMessage ? (
          <p className="ec-pop mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="limit-banner">
            🌙 {limitMessage}
          </p>
        ) : null}
      </section>

      <section className="ec-card">
        <h2 className="font-bold">{active ? "换个场景" : "选一个场景开始"}</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => start(s)}
              className={`rounded-xl border p-3 text-left transition ${
                active?.id === s.id
                  ? "border-[var(--ec-primary)] bg-[var(--ec-primary-soft)]"
                  : "border-[#e6e8f5] bg-white hover:border-[var(--ec-primary)]"
              }`}
            >
              <span className="block font-semibold">
                {isChild ? "🎈 " : ""}
                {s.title}
                <span className="ml-2 text-xs text-[var(--ec-muted)]">{s.title_zh}</span>
              </span>
              <span className="mt-1 block text-xs text-[var(--ec-muted)]">
                {s.level} · {s.min_age}+ 岁 · {s.setting_zh}
              </span>
            </button>
          ))}
        </div>
      </section>

      {active && sessionId ? (
        <section className="ec-card" data-testid="chat-panel">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">
              {active.title} <span className="text-sm text-[var(--ec-muted)]">{active.title_zh}</span>
            </h2>
            <span className="text-xs text-[var(--ec-muted)]">
              第 {messages.filter((m) => m.role === "user").length} 轮 / 最多 6 轮
            </span>
          </div>

          <div className="mt-3 flex max-h-[26rem] flex-col gap-3 overflow-y-auto rounded-xl bg-[#f8f9ff] p-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`ec-pop max-w-[85%] rounded-2xl px-3 py-2 ${
                  m.role === "user"
                    ? "self-end bg-[var(--ec-primary)] text-white"
                    : "self-start bg-white shadow-sm"
                }`}
              >
                <p className="font-medium">{m.text}</p>
                {m.text_zh ? <p className="mt-0.5 text-xs opacity-80">{m.text_zh}</p> : null}
                {m.correction?.has_error ? (
                  <div className="mt-2 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]">
                    <p>
                      更自然：<strong>{m.correction.better}</strong>
                    </p>
                    <p>{m.correction.explain_zh}</p>
                  </div>
                ) : null}
                {m.flag === "unsafe_filtered" ? (
                  <p className="mt-1 text-xs">（内容已按儿童安全规则替换）</p>
                ) : null}
                {m.role === "assistant" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ReplayButton
                      text={m.text}
                      rate={speechRate}
                      forcePlaying={speechStatus?.index === i && speechStatus.phase === "speaking"}
                      highlight={slowIndex === i}
                    />
                    {speechStatus?.index === i ? (
                      <span className="text-xs text-[var(--ec-muted)]" data-testid="speech-status">
                        {speechStatus.phase === "preparing" ? "🔊 正在准备语音…" : "🔊 正在说话…"}
                      </span>
                    ) : null}
                    {slowIndex === i ? (
                      <span className="text-xs text-[#b45309]" data-testid="speech-slow">
                        语音合成太慢，先不等了 —— 点「🔊 重试播放」
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={listEndRef} />
          </div>

          {done ? (
            <div className="ec-pop mt-3 rounded-xl bg-[var(--ec-primary-soft)] p-3 text-sm">
              🌟 这个场景练完啦，辛苦了！换个场景继续，或者去「错音本」复习一下。
            </div>
          ) : (
            <>
              {degradedLlm ? (
        <p
          className="rounded-xl bg-[#fff3d6] px-3 py-2 text-xs text-[#7a4d00]"
          data-testid="degraded-llm-banner"
        >
          ⚠️ 当前回复来自<strong>内置话术</strong>（还没接入大模型），它会按剧本往下走、
          不会真的回应你说的话。配好 `LLM_API_KEY` 并重启 voice 后即可变成智能对话。
        </p>
      ) : null}

      {suggestions.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2" data-testid="suggested-replies">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="ec-btn ec-btn-ghost"
                      disabled={busy}
                      onClick={() => send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : null}

              <form
                className="mt-3 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={isChild ? "打一句英语，或者点上面的句子" : "Type your reply in English…"}
                  className="min-w-0 flex-1 rounded-xl border border-[#d9dcf0] px-3 py-2"
                  disabled={busy}
                />
                <button type="submit" className="ec-btn ec-btn-primary" disabled={busy || !input.trim()}>
                  发送
                </button>
                <button
                  type="button"
                  className="ec-btn ec-btn-ghost"
                  onClick={() => setShowMic((v) => !v)}
                  disabled={busy}
                >
                  🎙️ 语音
                </button>
              </form>

              {showMic ? (
                <div className="mt-2 rounded-xl bg-[#f8f9ff] p-3">
                  <Recorder onRecorded={(blob) => voiceToText(blob)} disabled={busy} isChild={isChild} />
                </div>
              ) : null}
            </>
          )}

          {degraded ? (
            <p className="mt-2 text-xs text-[#b45309]">
              对话服务暂时不可用，已切换到本地固定话术（数据仍然完整保存）。
            </p>
          ) : null}
          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
