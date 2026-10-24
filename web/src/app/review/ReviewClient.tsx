"use client";

import { useState } from "react";
import type { ReviewData } from "@/lib/review-data";
import type { VoiceCapabilities } from "@/lib/types";

const GRADES: { grade: "again" | "hard" | "good" | "easy"; label: string; childLabel: string }[] = [
  { grade: "again", label: "再来一次", childLabel: "😵 还没会" },
  { grade: "hard", label: "有点难", childLabel: "🤔 有点难" },
  { grade: "good", label: "记住了", childLabel: "😀 会了" },
  { grade: "easy", label: "太简单", childLabel: "🤩 太简单" },
];

export function ReviewClient({
  isChild,
  data,
  capabilities,
  usage,
}: {
  isChild: boolean;
  data: ReviewData;
  capabilities: VoiceCapabilities;
  usage: { minutes: number; limitMinutes: number; remainingMinutes: number };
}) {
  const [cards, setCards] = useState(data.due_cards);
  const [stats, setStats] = useState(data.stats);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function grade(cardId: string, g: string) {
    setBusy(cardId);
    setError(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card_id: cardId, grade: g }),
      });
      const body = (await res.json()) as {
        next_due_at?: string;
        interval_days?: number;
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(body?.error?.message ?? "评分失败");
        return;
      }
      setCards((prev) => prev.filter((c) => c.id !== cardId));
      setStats((s) => ({ ...s, due_cards: Math.max(0, s.due_cards - 1) }));
      setLastResult(
        body.interval_days && body.interval_days > 0
          ? `下次复习：${body.interval_days} 天后 ✅`
          : "10 分钟后再来一次 🔁",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const maxTrend = Math.max(
    100,
    ...data.weak_phonemes.flatMap((w) => w.trend.map((t) => t.s)),
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">{isChild ? "📒 我的小错音本" : "📒 错音本 / SRS 复习"}</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          待复习 <strong data-testid="due-count">{stats.due_cards}</strong> 张 · 卡片总数{" "}
          {stats.total_cards} · 音素记录 {stats.phoneme_rows} 条 · 今日 {usage.minutes}/
          {usage.limitMinutes} 分钟
          {isChild ? ` · 还剩 ${usage.remainingMinutes} 分钟` : ""}
        </p>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          排期算法：SM-2 简化版（again/hard/good/easy）。
          {capabilities.phoneme_level
            ? ""
            : " 当前 provider 不支持音素级评分，下面的「高频错词」是单词级粗评。"}
        </p>
        {lastResult ? <p className="ec-pop mt-2 text-sm font-semibold">{lastResult}</p> : null}
        {error ? <p className="mt-2 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      </section>

      <section className="ec-card">
        <h2 className="font-bold">今天要复习的卡片</h2>
        {cards.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="no-due-cards">
            现在没有到期的卡片 🎉 去「跟读练习」多读几句，新的错音会自动进来。
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {cards.map((c) => (
              <li key={c.id} className="rounded-xl border border-[#e6e8f5] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-lg font-bold">
                      {c.is_phoneme && c.phoneme && !isChild ? (
                        <span className="mr-2 rounded-lg bg-[var(--ec-primary-soft)] px-2 py-0.5 font-mono text-base text-[var(--ec-primary)]">
                          {c.phoneme}
                        </span>
                      ) : null}
                      {c.label || c.display.text || "复习卡片"}
                    </p>
                    {c.why_zh ? (
                      <p className="text-sm text-[var(--ec-muted)]">{c.why_zh}</p>
                    ) : null}
                    <p className="text-sm">{c.how_zh || "放慢速度，把每个音都说完整。"}</p>
                    {c.practice_words.length > 0 ? (
                      <p className="mt-1 text-xs text-[var(--ec-muted)]">
                        练习词：{c.practice_words.join(" · ")}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-[var(--ec-muted)]">
                      {c.kind} · 已复习 {c.reps} 次 · 遗忘 {c.lapses} 次 · ease {c.ease.toFixed(2)}
                      {c.last_grade ? ` · 上次：${c.last_grade}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {GRADES.map((g) => (
                      <button
                        key={g.grade}
                        type="button"
                        className={`ec-btn ${g.grade === "good" ? "ec-btn-primary" : "ec-btn-ghost"}`}
                        disabled={busy === c.id}
                        onClick={() => grade(c.id, g.grade)}
                      >
                        {isChild ? g.childLabel : g.label}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ec-card">
        <h2 className="font-bold">{isChild ? "哪些音我常说不好" : "音素掌握度（最弱在前）"}</h2>
        {data.weak_phonemes.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ec-muted)]">
            还没有音素数据，先去做一次跟读评测吧。
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {data.weak_phonemes.map((w, wi) => (
              <li key={`${w.label}-${wi}`} className="flex items-center gap-3 text-sm">
                <span className="w-44 shrink-0 truncate" title={w.label}>
                  {w.label}
                </span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[#eef0f8]">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(2, Math.min(100, w.avg_score))}%`,
                      background:
                        w.avg_score >= 80 ? "#16a34a" : w.avg_score >= 60 ? "#f59e0b" : "#ef4444",
                    }}
                  />
                </span>
                <span className="w-24 text-right text-[var(--ec-muted)]">
                  均 {w.avg_score} · {w.attempts} 次
                </span>
                <svg width="70" height="22" viewBox="0 0 70 22" aria-label="趋势">
                  {w.trend.map((t, i) => (
                    <circle
                      key={i}
                      cx={4 + (i * 62) / Math.max(1, w.trend.length - 1)}
                      cy={20 - (t.s / maxTrend) * 18}
                      r="2.4"
                      fill="#5b5bd6"
                    />
                  ))}
                </svg>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.word_level_errors.length > 0 ? (
        <section className="ec-card" data-testid="word-level-errors">
          <h2 className="font-bold">
            高频错词（单词级粗评）
            <span className="ml-2 text-xs font-normal text-[var(--ec-muted)]">
              phoneme_level=false 时不冒充音素级
            </span>
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {data.word_level_errors.map((w) => (
              <li key={w.word} className="rounded-lg bg-[#fff3d6] px-3 py-1">
                <strong>{w.word}</strong> × {w.count}（均 {w.avg_score}）· 粗评
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
