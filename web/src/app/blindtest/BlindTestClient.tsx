"use client";

import Link from "next/link";
import { useState } from "react";
import { Recorder } from "@/components/Recorder";

interface BlindSentence {
  id: string;
  text: string;
  translation_zh: string;
}

interface BlindData {
  inProgress: boolean;
  blindTestId?: string;
  canStart?: boolean;
  plannedTotal: number;
  practicedCount: number;
  sentences: BlindSentence[];
  progress: { done: number; total: number };
}

/**
 * 盲测交互：**任何时刻都不显示分数**（契约 §13.3 第 1 条）。
 * 只显示「第 N / total 句」+ 进度条；服务端返回体里也只有 {attempt_id, blind, progress}。
 */
export function BlindTestClient({
  isChild,
  displayName,
  data,
}: {
  isChild: boolean;
  displayName: string;
  data: BlindData;
}) {
  const [inProgress, setInProgress] = useState(data.inProgress);
  const [blindTestId, setBlindTestId] = useState<string | null>(data.blindTestId ?? null);
  const [sentences] = useState<BlindSentence[]>(data.sentences);
  const [total, setTotal] = useState(data.progress.total || data.plannedTotal);
  const [done, setDone] = useState(data.progress.done);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [finished, setFinished] = useState<{ avg_pron: number | null; delta_pron: number | null } | null>(
    null,
  );

  const current = sentences[done] ?? null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/blind-tests", { method: "POST" });
      const body = (await res.json()) as {
        blind_test_id?: string;
        sentence_ids?: string[];
        total?: number;
        error?: { message?: string };
      };
      if (!res.ok || !body.blind_test_id) {
        setError(body?.error?.message ?? "无法开始盲测");
        return;
      }
      setBlindTestId(body.blind_test_id);
      setTotal(body.total ?? body.sentence_ids?.length ?? 0);
      setDone(0);
      setInProgress(true);
      // 句子文本由服务端页面提供；若本次是“重新开始”（例如上一批已作废），刷新页面即可
      if (sentences.length === 0) {
        window.location.reload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(blob: Blob, durationMs: number) {
    if (!blindTestId || !current) return;
    setBusy(true);
    setError(null);
    setLimitMessage(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `blind.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("sentence_id", current.id);
      form.append("reference_text", current.text);
      form.append("mode", "scripted");
      form.append("duration_ms", String(Math.round(durationMs)));
      form.append("blind_test_id", blindTestId);

      const res = await fetch("/api/attempts", { method: "POST", body: form });
      const body = (await res.json()) as {
        attempt_id?: string;
        blind?: boolean;
        progress?: { done: number; total: number };
        error?: { message?: string };
      };
      if (res.status === 429) {
        setLimitMessage(body?.error?.message ?? "今天的练习时间到啦 🌙");
        return;
      }
      if (!res.ok) {
        setError(body?.error?.message ?? "提交失败");
        return;
      }
      // 服务端只回 attempt_id / blind / progress —— 这里也不做任何分数展示
      const nextDone = body.progress?.done ?? done + 1;
      setDone(nextDone);
      if (nextDone >= (body.progress?.total ?? total)) {
        await finish();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!blindTestId) return;
    try {
      const res = await fetch(`/api/blind-tests/${blindTestId}/finish`, { method: "POST" });
      const body = (await res.json()) as {
        avg_pron?: number | null;
        delta_pron?: number | null;
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(body?.error?.message ?? "结束盲测失败");
        return;
      }
      setFinished({ avg_pron: body.avg_pron ?? null, delta_pron: body.delta_pron ?? null });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (finished) {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card ec-pop text-center">
          <div className="text-4xl">🎉</div>
          <h1 className="mt-2 text-xl font-extrabold">
            {isChild ? "小测验做完啦，你真棒！" : "盲测完成"}
          </h1>
          <p className="mt-2 text-sm text-[var(--ec-muted)]">
            {isChild
              ? "这次的成绩已经记到你的周报里了，去看看吧！"
              : "本次盲测成绩已写入周报（与上次的对比也在里面）。"}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/blindtest/report" className="ec-btn ec-btn-primary">
              📈 去看周报
            </Link>
            <Link href="/practice" className="ec-btn ec-btn-ghost">
              去跟读练习
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!inProgress) {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">
            {isChild ? "🎯 小测验（不给分数哦）" : "🎯 盲测（Blind Test）"}
          </h1>
          <p className="mt-2 text-sm text-[var(--ec-muted)]">
            {isChild
              ? `你好 ${displayName}！我们读几句话就好，中间不会给你打分，也不会告诉你哪里错了。读完之后再看周报，就能知道你这一周有没有进步啦 😊`
              : "同一组句子、全程不给任何反馈，和上一次的成绩对比 —— 这是唯一能证明「真的进步了」的指标。因为一旦看到分数，人会立刻重读，分数上升只是即时模仿。"}
          </p>
          <ul className="mt-3 list-disc pl-5 text-sm text-[var(--ec-muted)]">
            <li>句子从你**练过**的语料里抽，每次都是同一组，便于和上周对比。</li>
            <li>测试过程中页面只显示进度，不显示任何分数或反馈。</li>
            <li>结束后可以去看周报（分值 + 与上次的差值）。</li>
          </ul>
          {data.canStart === false ? (
            <p className="mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm">
              还没有练过的句子，暂时无法开始盲测。先去「跟读练习」读几句吧 🙂
              <Link href="/practice" className="ml-2 font-semibold underline">
                去跟读练习
              </Link>
            </p>
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <button type="button" className="ec-btn ec-btn-primary" onClick={start} disabled={busy}>
                {busy ? "准备中…" : `开始盲测（${data.plannedTotal} 句）`}
              </button>
              <span className="text-xs text-[var(--ec-muted)]">
                可抽题：{data.practicedCount} 句（来自你练过的语料）
              </span>
            </div>
          )}
          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-extrabold">
            {isChild ? "🎯 小测验进行中" : "🎯 盲测进行中"}
          </h1>
          <span className="rounded-full bg-[var(--ec-primary-soft)] px-3 py-1 text-sm font-semibold text-[var(--ec-primary)]">
            第 {Math.min(done + 1, total)} / {total} 句
          </span>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-[#eef0f8]">
          <div
            className="h-full rounded-full bg-[var(--ec-primary)] transition-all"
            style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            data-testid="blind-progress"
          />
        </div>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          这一轮不会有任何分数和反馈，读完 {total} 句才看得到结果 —— 这样才测得准 🙂
        </p>
        {limitMessage ? (
          <p className="ec-pop mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm">{limitMessage}</p>
        ) : null}
      </section>

      {current ? (
        <section className="ec-card">
          <h2 className="text-2xl font-extrabold leading-snug">{current.text}</h2>
          {current.translation_zh ? (
            <p className="mt-1 text-sm text-[var(--ec-muted)]">{current.translation_zh}</p>
          ) : null}
          <div className="mt-4">
            <Recorder onRecorded={submit} disabled={busy} isChild={isChild} recording={busy} />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button type="button" className="ec-btn ec-btn-ghost" onClick={finish} disabled={busy}>
              提前结束
            </button>
            <span className="text-xs text-[var(--ec-muted)]">
              提前结束只统计已提交的句子（不会给出分数）。
            </span>
          </div>
          {error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        </section>
      ) : (
        <section className="ec-card">
          <p className="text-sm">这一批的句子已经读完了。</p>
          <button type="button" className="ec-btn ec-btn-primary mt-3" onClick={finish}>
            结束并查看周报
          </button>
        </section>
      )}
    </div>
  );
}
