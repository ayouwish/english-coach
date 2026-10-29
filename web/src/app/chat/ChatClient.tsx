"use client";

import { useEffect, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
import { ttsUrl } from "@/lib/tts-url";
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
  /** 这条 user 消息是通过语音输入产生的 → 保留 object URL 供回放（task-19 B） */
  audioUrl?: string | null;
}

/** 语音状态（task-19 A）：不再 6s 中断，只提示进度；失败要可见 */
type AudioPhase = "loading" | "slow" | "maybeFailed" | "playing" | "blocked" | "error";

type Timers = { slow?: ReturnType<typeof setTimeout>; fail?: ReturnType<typeof setTimeout> };

function clearTimers(t: Timers) {
  if (t.slow) clearTimeout(t.slow);
  if (t.fail) clearTimeout(t.fail);
  t.slow = undefined;
  t.fail = undefined;
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
  ttsRate: initialTtsRate,
}: {
  isChild: boolean;
  age: number;
  scenarios: ScenarioItem[];
  hiddenCount: number;
  usage: Usage;
  voiceReachable: boolean;
  /** 服务端算好的有效语速（偏好优先；儿童默认 slow）—— task-21 */
  ttsRate: "slow" | "normal";
}) {
  const [active, setActive] = useState<ScenarioItem | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [degraded, setDegraded] = useState(false);
  // v1.4 §6：本条回复是否由「固定话术」生成（未接入大模型）
  const [degradedLlm, setDegradedLlm] = useState(false);
  const [usage, setUsage] = useState(initialUsage);
  const [done, setDone] = useState(false);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // ── 语音朗读：以**原生 <audio controls>** 为主路径（task-19 修"没声音"）────
  // 自动朗读只是"驱动那个原生元素 play()"：播放器的 ▶ 是真实用户手势，永远能播。
  // 不主动中断请求（Azure 合成新文本实测 1–11s，之前 6s AbortController 掐断是"点了没声音"的嫌疑之一）。
  const [autoRead, setAutoRead] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioPhase, setAudioPhase] = useState<Record<number, AudioPhase>>({});
  const audioRefs = useRef<Map<number, HTMLAudioElement | null>>(new Map());
  const userAudioUrls = useRef<string[]>([]);
  const pendingReadRef = useRef<number | null>(null);
  const [readTick, setReadTick] = useState(0);
  const lastAssistantRef = useRef<{ index: number; text: string } | null>(null);
  const timersRef = useRef<Timers>({});
  /** 当前朗读语速：初始值来自偏好（服务端算好），用户可在头部就地切换 */
  const [speechRate, setSpeechRate] = useState<"slow" | "normal">(initialTtsRate);
  const [rateSaving, setRateSaving] = useState(false);

  async function changeRate(next: "slow" | "normal") {
    if (next === speechRate || rateSaving) return;
    setRateSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tts_rate: next }),
      });
      if (res.ok) {
        stopAllAudio();
        setSpeechRate(next); // 之后的消息（以及回放）立刻用新语速，且已写入偏好
      }
    } catch {
      /* 静默：语速保存失败不影响对话 */
    } finally {
      setRateSaving(false);
    }
  }

  /** 停掉所有正在播的（不销毁元素：用户仍可点原生播放器的 ▶） */
  function stopAllAudio() {
    clearTimers(timersRef.current);
    for (const el of audioRefs.current.values()) {
      if (el && !el.paused) el.pause();
    }
    setAudioPhase({});
  }

  /** 请求自动朗读某条消息：先渲染文字，等 <audio> 挂载后由 effect 驱动 play() */
  function queueAutoRead(index: number, text: string) {
    lastAssistantRef.current = { index, text };
    if (!autoRead) return;
    pendingReadRef.current = index;
    setReadTick((t) => t + 1);
  }

  useEffect(() => {
    const index = pendingReadRef.current;
    if (index === null) return;
    pendingReadRef.current = null;
    const el = audioRefs.current.get(index);
    if (!el) return;

    clearTimers(timersRef.current);
    for (const other of audioRefs.current.values()) {
      if (other && !other.paused) other.pause(); // 不重叠
    }
    setAudioPhase({ [index]: "loading" });
    // 6s：只提示"还在生成"（不中断！）；20s：提示可能失败，引导点播放器
    timersRef.current.slow = setTimeout(
      () => setAudioPhase((p) => ({ ...p, [index]: "slow" })),
      6000,
    );
    timersRef.current.fail = setTimeout(
      () => setAudioPhase((p) => ({ ...p, [index]: "maybeFailed" })),
      20000,
    );
    el.play()
      .then(() => {
        clearTimers(timersRef.current);
        setAudioPhase((p) => ({ ...p, [index]: "playing" }));
      })
      .catch(() => {
        clearTimers(timersRef.current);
        setAudioPhase((p) => ({ ...p, [index]: "blocked" }));
        setAudioBlocked(true);
      });
  }, [readTick]);

  /** 用户点「点这里开启朗读」：一次真实手势 → 播放最后一条 */
  async function unlockSpeech() {
    setAutoRead(true);
    setAudioBlocked(false);
    const last = lastAssistantRef.current;
    const el = last ? audioRefs.current.get(last.index) : null;
    if (!last || !el) return;
    try {
      await el.play();
      setAudioPhase((p) => ({ ...p, [last.index]: "playing" }));
    } catch {
      setAudioPhase((p) => ({ ...p, [last.index]: "blocked" }));
      setAudioBlocked(true);
    }
  }

  // 卸载：停播 + 释放"我自己录的" object URL（task-19 B）
  useEffect(() => {
    // 卸载时按"当时的容器"清理：把 ref 内容在挂载时固定下来，避免 lint 警告的陈旧引用问题
    const timers = timersRef;
    const urls = userAudioUrls;
    return () => {
      clearTimers(timers.current);
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = [];
    };
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function start(scenario: ScenarioItem) {
    // 切场景：停播 + 释放上一轮"我的录音" object URL（task-19 B）
    stopAllAudio();
    userAudioUrls.current.forEach((u) => URL.revokeObjectURL(u));
    userAudioUrls.current = [];
    setAudioBlocked(false);
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
      queueAutoRead(0, opening);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string, audioUrl?: string | null) {
    if (!sessionId || !text.trim()) return;
    // 新的一轮开始：先停掉上一条朗读（不阻塞输入，用户可以立刻继续说话/打字）
    stopAllAudio();
    setBusy(true);
    setError(null);
    const assistantIndex = messages.length + 1; // 用户消息后的那条
    setMessages((prev) => [...prev, { role: "user", text, audioUrl: audioUrl ?? null }]);
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
      // 文字已经渲染（上面的 setMessages）；这里只是驱动原生 <audio> 自动播，绝不阻塞消息出现
      queueAutoRead(assistantIndex, data.reply);
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
      // 保留这次的录音，渲染在该条 user 消息下（task-19 B）
      const audioUrl = URL.createObjectURL(blob);
      userAudioUrls.current.push(audioUrl);
      if (userAudioUrls.current.length > 6) {
        const old = userAudioUrls.current.shift();
        if (old) URL.revokeObjectURL(old);
      }
      await send(data.text, audioUrl);
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
              if (!next) stopAllAudio();
            }}
            className={`ec-btn ${autoRead ? "ec-btn-primary" : "ec-btn-ghost"}`}
          >
            {autoRead ? "🔊 自动朗读：开" : "🔇 自动朗读：关"}
          </button>
          <span className="text-xs text-[var(--ec-muted)]">
            每条回复会自动读出来（当前：{speechRate === "slow" ? "慢速" : "正常语速"}）。
            合成通常需要几秒，<strong>已经预热过的句子是秒出</strong>；期间消息旁会显示进度。
            每条消息下面都有一个原生播放器，点它的 ▶ 一定能播。
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">朗读语速：</span>
          <button
            type="button"
            data-testid="chat-rate-slow"
            data-rate="slow"
            aria-pressed={speechRate === "slow"}
            aria-label="把朗读语速设为慢速"
            onClick={() => void changeRate("slow")}
            disabled={rateSaving}
            className={`ec-btn ${speechRate === "slow" ? "ec-btn-primary" : "ec-btn-ghost"}`}
          >
            🐢 慢速
          </button>
          <button
            type="button"
            data-testid="chat-rate-normal"
            data-rate="normal"
            aria-pressed={speechRate === "normal"}
            aria-label="把朗读语速设为正常"
            onClick={() => void changeRate("normal")}
            disabled={rateSaving}
            className={`ec-btn ${speechRate === "normal" ? "ec-btn-primary" : "ec-btn-ghost"}`}
          >
            🐇 正常
          </button>
          <span className="text-xs text-[var(--ec-muted)]">
            慢速更清楚，但合成耗时约为正常语速的 2.3 倍（等待更久）。切换会保存在设置里。
          </span>
        </div>

        {audioBlocked ? (
          <button
            type="button"
            data-testid="speech-unlock"
            aria-label="点这里开启朗读"
            onClick={unlockSpeech}
            className="ec-pop mt-2 block w-full rounded-xl bg-[#fff3d6] p-3 text-left text-sm"
          >
            🔇 浏览器拦截了自动播放 —— <strong>点这里开启朗读</strong>（也可以直接点消息下面播放器的 ▶）
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

                {/* 用户自己说的（语音输入）→ 可回放（task-19 B） */}
                {m.role === "user" && m.audioUrl ? (
                  <audio
                    controls
                    preload="none"
                    src={m.audioUrl}
                    data-testid="user-audio"
                    aria-label="回放我刚才说的话"
                    className="mt-2 h-8 w-full max-w-[220px]"
                  />
                ) : null}

                {/* AI 回复：原生播放器是主路径（▶ 是真实手势，永远能播）*/}
                {m.role === "assistant" ? (
                  <div className="mt-2">
                    <audio
                      controls
                      preload="none"
                      src={ttsUrl(m.text, speechRate, "mp3")}
                      data-testid="tts-audio"
                      aria-label={`朗读这句话：${m.text}`}
                      className="h-9 w-full max-w-[280px]"
                      ref={(el) => {
                        if (el) audioRefs.current.set(i, el);
                        else audioRefs.current.delete(i);
                      }}
                      onPlay={() => setAudioPhase((p) => ({ ...p, [i]: "playing" }))}
                      onEnded={() =>
                        setAudioPhase((p) => {
                          const next = { ...p };
                          delete next[i];
                          return next;
                        })
                      }
                      onError={() => setAudioPhase((p) => ({ ...p, [i]: "error" }))}
                    />
                    {audioPhase[i] ? (
                      <p
                        className="mt-1 text-xs"
                        data-testid="tts-status"
                        style={{ color: audioPhase[i] === "error" || audioPhase[i] === "maybeFailed" ? "#b45309" : "#6b7290" }}
                      >
                        {audioPhase[i] === "playing"
                          ? "🔊 正在说话…"
                          : audioPhase[i] === "loading"
                            ? "⏳ 语音生成中…（通常几秒）"
                            : audioPhase[i] === "slow"
                              ? "⏳ 语音还在生成，稍等一下…"
                              : audioPhase[i] === "maybeFailed"
                                ? "⚠️ 语音可能生成失败 —— 点上面播放器的 ▶ 重试"
                                : audioPhase[i] === "error"
                                  ? "⚠️ 语音未加载（点上面播放器的 ▶ 重试）"
                                  : "🔇 浏览器拦了自动播放 —— 点上面播放器的 ▶ 就能听"}
                      </p>
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
          不会真的回应你说的话。配好 <code>LLM_API_KEY</code> 并重启 voice 后即可变成智能对话。
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

              {/* 对话练习只练"说"：保留录音，不要文字输入框（task-32） */}
              <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="speak-panel">
                <p className={isChild ? "text-lg font-extrabold" : "text-sm font-extrabold"}>
                  🎤 {isChild ? "直接说出来就好 🙂" : "说英语（开口练习）"}
                </p>
                <p className="mt-1 text-xs text-[var(--ec-muted)]">
                  {isChild
                    ? "点一下大按钮，看到「说完啦」就可以开始说英语啦；说完再点一次。"
                    : "点下面的按钮开始录音，说完再点一次停止；不需要打字，练的就是开口说。"}
                </p>
                <div className="mt-2">
                  <Recorder onRecorded={(blob) => voiceToText(blob)} disabled={busy} isChild={isChild} />
                </div>
                {busy ? (
                  <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="speak-busy">
                    {isChild ? "听到啦，正在想怎么回你… ⏳" : "识别 / 回复中…请稍候 ⏳"}
                  </p>
                ) : null}
              </div>

              {/* 没有文字输入框了 → 麦克风不可用时必须给可操作的排查步骤（不许静默） */}
              <p
                className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-xs text-[#7a4d00]"
                data-testid="mic-required-note"
                role="note"
              >
                🎤 本页需要<strong>麦克风</strong>才能对话（没有输入框）。如果点了没反应，请展开下面的排查步骤。
              </p>
              <details className="mt-2 rounded-xl bg-white p-3 text-xs" data-testid="mic-troubleshoot">
                <summary className="cursor-pointer font-semibold text-[#7a4d00]">
                  麦克风没反应？点这里看排查步骤
                </summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--ec-muted)]">
                  <li>浏览器地址栏左侧点锁图标 → 把「麦克风」设为「允许」，然后刷新页面。</li>
                  <li>必须用 https 打开（本地 http://localhost 例外）；局域网 http 地址拿不到麦克风。</li>
                  <li>换 Chrome / Edge / Safari 再试；耳机或会议软件占用麦克风时先关掉。</li>
                  <li>仍然不行：请家长检查系统麦克风权限，或换一台设备试试。</li>
                </ol>
              </details>
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
