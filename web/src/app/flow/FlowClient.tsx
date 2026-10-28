"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Recorder } from "@/components/Recorder";
import { FeedbackCard, IssuesSection } from "@/components/ResultSections";
import { ScoreRadar } from "@/components/ScoreRadar";
import { WordBars } from "@/components/WordBars";
import type { FeedbackResult, PronounceIssue, PronounceResult } from "@/lib/types";

interface CorpusSentence {
  id: string;
  text: string;
  level: string;
}

interface FlowItem {
  /** 本地序号 */
  index: number;
  text: string;
  sentenceId: string | null;
  source: "corpus" | "custom";
  attemptId: string | null;
  status: "unsent" | "pending" | "scoring" | "done" | "failed";
  error: string | null;
  result: {
    scores: PronounceResult["scores"] | null;
    words: PronounceResult["words"];
    issues: PronounceIssue[];
    feedback: FeedbackResult | null;
    intonation: PronounceResult["intonation"] | null;
    recognized_text: string | null;
  } | null;
}

type Phase = "setup" | "running" | "summary";

const COUNTS = [5, 10, 15];

/** 把一段文本按 . ! ? 。！？ 切成句子（过滤空句；保留句末标点） */
export function splitSentences(raw: string): string[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (/[.!?。！？]/.test(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.replace(/[^\p{L}\p{N}]/gu, "").length > 0);
}

/**
 * 连读模式（task-24）：录完一句立刻进入下一句，评分在后台排队；右侧列表轮询更新。
 * - 复用现有 Recorder（不改它）
 * - 儿童：大字号/大按钮、文案口语化、绝不出现 IPA
 * - 失败可见：每条显示失败原因 + 「重录这句」
 */
export function FlowClient({
  isChild,
  userLevel,
  corpus,
  voiceReachable,
}: {
  isChild: boolean;
  userLevel: string;
  corpus: CorpusSentence[];
  voiceReachable: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [mode, setMode] = useState<"corpus" | "custom">("corpus");
  const [level, setLevel] = useState(userLevel || "A1");
  const [start, setStart] = useState(0);
  const [count, setCount] = useState(5);
  const [customText, setCustomText] = useState("");
  const [customSentences, setCustomSentences] = useState<string[]>([]);
  const [items, setItems] = useState<FlowItem[]>([]);
  const [current, setCurrent] = useState(0);
  const [autoNext, setAutoNext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const levels = useMemo(() => [...new Set(corpus.map((s) => s.level))].sort(), [corpus]);
  const levelSentences = useMemo(() => corpus.filter((s) => s.level === level), [corpus, level]);
  const preview = useMemo(
    () => levelSentences.slice(start, start + count),
    [levelSentences, start, count],
  );

  function startCorpus() {
    if (preview.length === 0) {
      setError(isChild ? "这里还没有句子，换一个起点吧" : "这个位置没有句子，换个起点或级别试试");
      return;
    }
    setItems(
      preview.map((s, i) => ({
        index: i,
        text: s.text,
        sentenceId: s.id,
        source: "corpus",
        attemptId: null,
        status: "unsent",
        error: null,
        result: null,
      })),
    );
    beginRun();
  }

  function startCustom() {
    const list = customSentences.length > 0 ? customSentences : splitSentences(customText);
    if (list.length === 0) {
      setError(isChild ? "先写几句话吧" : "先输入一段文本，再点「切句」");
      return;
    }
    setCustomSentences(list);
    setItems(
      list.map((text, i) => ({
        index: i,
        text,
        sentenceId: null,
        source: "custom" as const,
        attemptId: null,
        status: "unsent" as const,
        error: null,
        result: null,
      })),
    );
    beginRun();
  }

  function beginRun() {
    setCurrent(0);
    setExpanded(null);
    setError(null);
    setPhase("running");
  }

  // 轮询：还有 pending/scoring 时每 1.2s 查一次
  const refreshStatuses = useCallback(async () => {
    const ids = items
      .filter((it) => it.attemptId && (it.status === "pending" || it.status === "scoring"))
      .map((it) => it.attemptId as string);
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/attempts/status?ids=${encodeURIComponent(ids.join(","))}`);
      const data = (await res.json()) as {
        items?: { id: string; status: string; error: string | null; result: FlowItem["result"] }[];
      };
      if (!res.ok || !data.items) return;
      const byId = new Map(data.items.map((x) => [x.id, x]));
      setItems((prev) =>
        prev.map((it) => {
          if (!it.attemptId) return it;
          const upd = byId.get(it.attemptId);
          if (!upd) return it;
          return {
            ...it,
            status: upd.status as FlowItem["status"],
            error: upd.error,
            result: upd.result,
          };
        }),
      );
    } catch {
      /* 轮询失败静默重试（下一轮） */
    }
  }, [items]);

  useEffect(() => {
    if (phase !== "running") return;
    const anyPending = items.some((it) => it.status === "pending" || it.status === "scoring");
    if (!anyPending) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => void refreshStatuses(), 1200);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [phase, items, refreshStatuses]);

  // 全部处理完 → 汇总
  useEffect(() => {
    if (phase !== "running" || items.length === 0) return;
    const allSettled = items.every((it) => it.status === "done" || it.status === "failed");
    if (allSettled && items.every((it) => it.status !== "unsent")) setPhase("summary");
  }, [phase, items]);

  async function submit(blob: Blob, durationMs: number) {
    const item = items[current];
    if (!item) return;
    setBusy(true);
    setError(null);
    setLimitMessage(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `flow.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("reference_text", item.text);
      form.append("mode", "scripted");
      form.append("source", item.source);
      if (item.sentenceId) form.append("sentence_id", item.sentenceId);
      form.append("duration_ms", String(Math.round(durationMs)));

      const res = await fetch("/api/attempts/async", { method: "POST", body: form });
      const data = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };
      if (res.status === 429) {
        setLimitMessage(data?.error?.message ?? "今天的练习时间到啦 🌙");
        return;
      }
      if (!res.ok || !data.id) {
        setError(data?.error?.message ?? `提交失败（HTTP ${res.status}）—— 可以再录一次`);
        return;
      }
      setItems((prev) =>
        prev.map((it, i) =>
          i === current ? { ...it, attemptId: data.id as string, status: "pending" as const } : it,
        ),
      );
      // 立刻进入下一句（400ms 缓冲），评分留在后台
      const next = current + 1;
      if (next < items.length) {
        if (autoNext) setTimeout(() => setCurrent(next), 400);
        else setCurrent(next);
      }
    } catch (err) {
      setError(`${(err as Error).message}。可以再录一次，或稍后重试`);
    } finally {
      setBusy(false);
    }
  }

  function redo(index: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === index ? { ...it, attemptId: null, status: "unsent", error: null, result: null } : it,
      ),
    );
    setCurrent(index);
    setExpanded(null);
    setPhase("running");
  }

  const doneItems = items.filter((it) => it.status === "done" && it.result?.scores);
  const avgPron =
    doneItems.length > 0
      ? Math.round(
          (doneItems.reduce((a, it) => a + (it.result?.scores?.pron ?? 0), 0) / doneItems.length) * 10,
        ) / 10
      : null;
  const worst = [...doneItems]
    .sort((a, b) => (a.result?.scores?.pron ?? 0) - (b.result?.scores?.pron ?? 0))
    .slice(0, 3);

  const progress = items.length > 0 ? Math.round((items.filter((it) => it.status !== "unsent").length / items.length) * 100) : 0;

  // ── 设置阶段 ────────────────────────────────────────────────────────────────
  if (phase === "setup") {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">🔗 {isChild ? "一口气读好多句" : "连读模式"}</h1>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            {isChild
              ? "读完一句就自动跳到下一句，不用等评分。读完后分数会自己出现在下面的列表里 🙂"
              : "逐句连读：录完一句立刻进入下一句，评分在后台排队，结果陆续显示（每句仍有完整音素级反馈）。"}
          </p>
          {!voiceReachable ? (
            <p className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-xs">
              ⚠️ 语音评测服务暂时不可用：句子仍会入库为「待评分」，服务恢复后可重试。
            </p>
          ) : null}
        </section>

        <section className="ec-card">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`ec-btn ${mode === "corpus" ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setMode("corpus")}
            >
              📚 从语料选
            </button>
            <button
              type="button"
              className={`ec-btn ${mode === "custom" ? "ec-btn-primary" : "ec-btn-ghost"}`}
              onClick={() => setMode("custom")}
            >
              ✍️ 自己输入一段
            </button>
          </div>

          {mode === "corpus" ? (
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  级别
                  <select
                    value={level}
                    onChange={(e) => {
                      setLevel(e.target.value);
                      setStart(0);
                    }}
                    className="rounded-xl border border-[#d9dcf0] px-2 py-1"
                  >
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  从第
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, levelSentences.length - 1)}
                    value={start}
                    onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                    className="w-16 rounded-xl border border-[#d9dcf0] px-2 py-1"
                  />
                  句开始
                </label>
                <label className="flex items-center gap-2">
                  读
                  <select
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    className="rounded-xl border border-[#d9dcf0] px-2 py-1"
                  >
                    {COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  句
                </label>
              </div>
              <ol className="list-decimal pl-6 text-sm" data-testid="flow-preview">
                {preview.map((s) => (
                  <li key={s.id} className="py-0.5">
                    {s.text}
                  </li>
                ))}
                {preview.length === 0 ? <li className="text-[var(--ec-muted)]">这个位置没有句子</li> : null}
              </ol>
              <div>
                <button type="button" className="ec-btn ec-btn-primary" data-testid="flow-start" onClick={startCorpus}>
                  🎤 开始连读（{preview.length} 句）
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                rows={4}
                placeholder="把想读的英文段落贴进来（会按 . ! ? 。！？ 自动切句）"
                className="w-full rounded-xl border border-[#d9dcf0] px-3 py-2 text-sm"
                data-testid="flow-custom-input"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ec-btn ec-btn-ghost"
                  data-testid="flow-split"
                  onClick={() => {
                    setCustomSentences(splitSentences(customText));
                    setError(null);
                  }}
                >
                  ✂️ 切句
                </button>
                <span className="text-xs text-[var(--ec-muted)]">
                  切出 {customSentences.length} 句（可逐句修改后再开始）
                </span>
              </div>
              {customSentences.length > 0 ? (
                <ol className="flex flex-col gap-2">
                  {customSentences.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-6 text-right text-xs text-[var(--ec-muted)]">{i + 1}</span>
                      <input
                        value={s}
                        onChange={(e) =>
                          setCustomSentences((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        className="min-w-0 flex-1 rounded-lg border border-[#d9dcf0] px-2 py-1 text-sm"
                      />
                    </li>
                  ))}
                </ol>
              ) : null}
              <div>
                <button
                  type="button"
                  className="ec-btn ec-btn-primary"
                  data-testid="flow-start-custom"
                  disabled={customSentences.length === 0}
                  onClick={startCustom}
                >
                  🎤 开始连读（{customSentences.length} 句）
                </button>
              </div>
            </div>
          )}

          {error ? (
            <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    );
  }

  // ── 汇总阶段 ────────────────────────────────────────────────────────────────
  if (phase === "summary") {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">🎉 {isChild ? "读完啦！" : "连读完成"}</h1>
          <p className="mt-2 text-sm">
            共 {items.length} 句 · 已评分 {doneItems.length} 句
            {items.some((it) => it.status === "failed") ? ` · 失败 ${items.filter((it) => it.status === "failed").length} 句` : ""}
            {avgPron !== null ? (
              <>
                {" "}
                · 平均 <strong className="text-lg">{avgPron}</strong> 分
              </>
            ) : null}
          </p>
          {worst.length > 0 ? (
            <div className="mt-3" data-testid="flow-worst">
              <h2 className="font-bold">{isChild ? "这几句可以再读一遍" : "最需要再练的几句"}</h2>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {worst.map((it) => (
                  <li key={it.index}>
                    {it.result?.scores?.pron ?? "—"} 分 · {it.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="ec-btn ec-btn-primary" href="/report">
              📊 看发音诊断
            </Link>
            <button
              type="button"
              className="ec-btn ec-btn-ghost"
              onClick={() => {
                setPhase("setup");
                setItems([]);
              }}
            >
              再读一段
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          {items.map((it) => (
            <FlowRow
              key={it.index}
              item={it}
              isChild={isChild}
              expanded={expanded === it.index}
              onToggle={() => setExpanded(expanded === it.index ? null : it.index)}
              onRedo={() => redo(it.index)}
            />
          ))}
        </section>
      </div>
    );
  }

  // ── 连读中 ──────────────────────────────────────────────────────────────────
  const item = items[current];
  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-extrabold">🔗 {isChild ? "一句一句读" : "连读模式"}</h1>
          <span className="rounded-full bg-[var(--ec-primary-soft)] px-3 py-1 text-sm font-semibold text-[var(--ec-primary)]">
            {isChild ? "第" : "第"} {Math.min(current + 1, items.length)} / {items.length} {isChild ? "句" : "句"}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#eef0f8]">
          <div className="h-full rounded-full bg-[var(--ec-primary)] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ec-muted)]">
          <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} />
          {isChild ? "读完自动跳到下一句" : "录完后自动进入下一句（400ms 缓冲）"}
        </label>
        {limitMessage ? (
          <p className="mt-2 rounded-xl bg-[#fff3d6] p-3 text-sm" data-testid="limit-banner">
            🌙 {limitMessage}
          </p>
        ) : null}
      </section>

      {item ? (
        <section className="ec-card">
          <p className={isChild ? "text-3xl font-extrabold leading-snug" : "text-2xl font-extrabold leading-snug"}>
            {item.text}
          </p>
          <div className="mt-4">
            <Recorder onRecorded={submit} disabled={busy} isChild={isChild} recording={busy} />
          </div>
          {item.status !== "unsent" ? (
            <p className="mt-2 text-xs text-[var(--ec-muted)]">
              这一句已提交，{item.status === "pending" ? "正在排队评分…" : item.status === "scoring" ? "正在评分…" : item.status === "done" ? "已评分 ✅" : "评分失败"}
              （可以继续读下一句）
            </p>
          ) : null}
          {!autoNext && current + 1 < items.length ? (
            <button type="button" className="ec-btn ec-btn-ghost mt-2" onClick={() => setCurrent(current + 1)}>
              下一句 →
            </button>
          ) : null}
          {error ? (
            <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="flow-error">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2" data-testid="flow-list">
        <h2 className="font-bold">{isChild ? "评分结果（会自动更新）" : "实时评分"}</h2>
        {items.map((it) => (
          <FlowRow
            key={it.index}
            item={it}
            isChild={isChild}
            expanded={expanded === it.index}
            onToggle={() => setExpanded(expanded === it.index ? null : it.index)}
            onRedo={() => redo(it.index)}
            highlight={it.index === current}
          />
        ))}
      </section>
    </div>
  );
}

function FlowRow({
  item,
  isChild,
  expanded,
  onToggle,
  onRedo,
  highlight = false,
}: {
  item: FlowItem;
  isChild: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRedo: () => void;
  highlight?: boolean;
}) {
  const score = item.result?.scores?.pron ?? null;
  const badge =
    item.status === "done"
      ? `${score ?? "—"} 分`
      : item.status === "scoring"
        ? "评分中…"
        : item.status === "pending"
          ? "待评分…"
          : item.status === "failed"
            ? "评分失败"
            : "未读";
  return (
    <article
      className={`ec-card ${highlight ? "border-2 border-[var(--ec-primary)]" : ""}`}
      data-testid="flow-item"
      data-status={item.status}
    >
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={onToggle}>
        <span className="min-w-0 flex-1 truncate text-sm">
          {item.index + 1}. {item.text}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
            item.status === "done" ? "bg-[#e8f7ee] text-[#166534]" : item.status === "failed" ? "bg-red-50 text-red-700" : "bg-[#eef0f8]"
          }`}
          data-testid="flow-item-status"
        >
          {badge}
        </span>
      </button>

      {item.status === "failed" ? (
        <p className="mt-2 text-xs text-red-700">
          {item.error ?? "评分失败"}
          <button type="button" className="ec-btn ec-btn-ghost ml-2 !px-2 !py-0.5 text-xs" onClick={onRedo}>
            重录这句
          </button>
        </p>
      ) : null}

      {expanded && item.result ? (
        <div className="mt-3 flex flex-col gap-3" data-testid="flow-item-detail">
          <ScoreRadar
            scores={
              item.result.scores ?? {
                pron: null,
                accuracy: null,
                fluency: null,
                completeness: null,
                prosody: null,
              }
            }
            isChild={isChild}
          />
          <WordBars words={item.result.words ?? []} isChild={isChild} />
          <FeedbackCard feedback={item.result.feedback} isChild={isChild} />
          <IssuesSection issues={item.result.issues ?? []} isChild={isChild} phonemeLevel={false} />
        </div>
      ) : null}
    </article>
  );
}
