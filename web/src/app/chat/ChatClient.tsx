"use client";

import { useEffect, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
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
  const [usage, setUsage] = useState(initialUsage);
  const [done, setDone] = useState(false);
  const [showMic, setShowMic] = useState(false);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function start(scenario: ScenarioItem) {
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string) {
    if (!sessionId || !text.trim()) return;
    setBusy(true);
    setError(null);
    setInput("");
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
      setUsage((u) => ({ ...u, minutes: Math.round((u.minutes + 0.5) * 10) / 10 }));
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
