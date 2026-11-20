"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Voice { id: string; label_zh: string; lang: string }
interface Status {
  job_id: string | null;
  state: "idle" | "running" | "done" | "failed" | "cancelled";
  total: number; done: number; generated: number; cached: number; failed: number;
  skipped_duplicates?: number; chars_generated?: number; error?: string | null;
}
interface Meta {
  sentences: { count: number; chars: number };
  voices: Voice[];
  rates: ("normal" | "slow")[];
  estimate: { items: number; chars: number; cost_cny: number; price_per_1k_chars: number };
  prices: { tts_warmup_per_1k_chars: number };
  status: Status | null;
  status_error: string | null;
}

const yuan = (n: number) => `¥${n.toFixed(2)}`;

/** 后台「🎧 音色缓存预热」（task-115）。 */
export function AdminTtsWarmup() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [rates, setRates] = useState<("normal" | "slow")[]>(["normal", "slow"]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/tts-warmup", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (Meta & { error?: { message?: string } }) | null;
      if (!res.ok) { setError(body?.error?.message ?? `读取失败（HTTP ${res.status}）`); return; }
      setMeta(body);
      setStatus(body?.status ?? null);
      setVoices((prev) => (prev.length > 0 ? prev : (body?.voices ?? []).map((v) => v.id)));
    } catch (err) { setError(`读取失败：${(err as Error).message}`); }
  }, []);
  useEffect(() => void load(), [load]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/tts-warmup", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Meta | null;
      if (!res.ok || !body) return;
      setStatus(body.status ?? null);
      setMeta((m) => (m ? { ...m, estimate: body.estimate } : body));
    } catch { /* 轮询失败忽略，下一轮再试 */ }
  }, []);

  useEffect(() => {
    if (status?.state !== "running") {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return;
    }
    if (!timer.current) timer.current = setInterval(() => void poll(), 2000);
    return () => { /* 组件卸载时清理 */ };
  }, [status?.state, poll]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function start() {
    if (!meta) return;
    const est = estimateFor(meta, voices, rates);
    if (!window.confirm(`预计 ${est.items} 条、${est.chars} 字符，估算成本约 ${yuan(est.cost_cny)}（按 Azure TTS 刊例，实际以账单为准）。开始预热？`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/admin/tts-warmup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voices, rates }),
      });
      const body = (await res.json().catch(() => null)) as { job_id?: string; total?: number; error?: { message?: string } } | null;
      if (!res.ok) { setError(body?.error?.message ?? `启动失败（HTTP ${res.status}）`); return; }
      setNotice(`预热已开始：共 ${body?.total ?? "?"} 条`);
      await poll();
    } catch (err) { setError(`启动失败：${(err as Error).message}`); } finally { setBusy(false); }
  }

  async function cancel() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/tts-warmup/cancel", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { state?: string; error?: { message?: string } } | null;
      if (!res.ok) { setError(body?.error?.message ?? `取消失败（HTTP ${res.status}）`); return; }
      setNotice(`已取消（state=${body?.state ?? "cancelled"}）`);
      await poll();
    } catch (err) { setError(`取消失败：${(err as Error).message}`); } finally { setBusy(false); }
  }

  const running = status?.state === "running";
  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <section className="ec-card" data-testid="admin-warmup">
      <h2 className="text-base font-extrabold">🎧 音色缓存预热</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        一键缓存全部语料 × 音色 × 语速；预热后切换音色/语速时示范音秒出。缓存命中不重复计费；成本按 Azure TTS 刊例估算，实际以账单为准。
      </p>
      {error ? <p className="mt-2 rounded-xl bg-red-50 p-2 text-xs text-red-700" role="alert" data-testid="admin-warmup-error">{error}</p> : null}
      {notice ? <p className="mt-2 rounded-xl bg-[#e8f7ee] p-2 text-xs text-[#166534]" data-testid="admin-warmup-notice">{notice}</p> : null}
      {meta ? (
        <>
          <p className="mt-2 text-sm" data-testid="admin-warmup-estimate">
            语料 {meta.sentences.count} 句（{meta.sentences.chars} 字符） × {meta.voices.length} 音色 × {meta.rates.length} 语速 ={" "}
            <strong>{meta.estimate.items}</strong> 条 / <strong>{meta.estimate.chars}</strong> 字符 · 预计{" "}
            <strong>{yuan(meta.estimate.cost_cny)}</strong>（单价 ¥{meta.prices.tts_warmup_per_1k_chars}/千字符）
          </p>
          {meta.status_error ? <p className="mt-1 text-xs text-[#7a4d00]" data-testid="admin-warmup-status-error">{meta.status_error}</p> : null}
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <span className="font-semibold">语速：</span>
            {meta.rates.map((r) => (
              <label key={r} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid={`admin-warmup-rate-${r}`}
                  checked={rates.includes(r)}
                  onChange={(e) => setRates((prev) => (e.target.checked ? [...prev, r] : prev.filter((x) => x !== r)))}
                />
                {r === "normal" ? "正常" : "慢速"}
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="font-semibold">音色（默认全选）：</span>
            {meta.voices.map((v) => (
              <label key={v.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid={`admin-warmup-voice-${v.id}`}
                  checked={voices.includes(v.id)}
                  onChange={(e) => setVoices((prev) => (e.target.checked ? [...prev, v.id] : prev.filter((x) => x !== v.id)))}
                />
                {v.label_zh}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ec-btn ec-btn-primary !px-2 !py-1 text-xs"
              data-testid="admin-warmup-start"
              disabled={busy || running || voices.length === 0 || rates.length === 0}
              onClick={() => void start()}
            >
              {running ? "预热中…" : status?.state === "done" || status?.state === "cancelled" ? "再次预热（只补缺失缓存）" : "一键预热全部音色"}
            </button>
            <button
              type="button"
              className="ec-btn ec-btn-ghost !px-2 !py-1 text-xs"
              data-testid="admin-warmup-cancel"
              disabled={busy || !running}
              onClick={() => void cancel()}
            >
              取消预热
            </button>
            <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-1 text-xs" onClick={() => void load()} disabled={busy}>
              刷新状态
            </button>
          </div>
          {status && status.state !== "idle" ? (
            <div className="mt-2 text-xs" data-testid="admin-warmup-status" data-state={status.state}>
              <p>
                状态：<strong>{status.state}</strong> · 进度 {status.done}/{status.total}（{pct}%） · 生成 {status.generated} / 缓存命中{" "}
                {status.cached} / 失败 {status.failed}
                {typeof status.chars_generated === "number" ? ` · 已生成 ${status.chars_generated} 字符` : ""}
              </p>
              <div className="mt-1 h-2 w-full max-w-md overflow-hidden rounded-full bg-[#eef0f8]">
                <div className="h-full rounded-full bg-[var(--ec-primary)]" style={{ width: `${pct}%` }} />
              </div>
              {status.error ? <p className="mt-1 text-[#7a4d00]">{status.error}</p> : null}
              {status.state === "done" ? (
                <p className="mt-1 text-[#166534]" data-testid="admin-warmup-done">
                  完成：生成 {status.generated}、缓存命中 {status.cached}、失败 {status.failed}（合计 {status.done}/{status.total}）
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs text-[var(--ec-muted)]">读取中…</p>
      )}
    </section>
  );
}

function estimateFor(meta: Meta, voices: string[], rates: string[]) {
  const v = voices.length || meta.voices.length;
  const r = rates.length || meta.rates.length;
  const items = meta.sentences.count * v * r;
  const chars = meta.sentences.chars * v * r;
  const cost = Math.round((chars / 1000) * meta.prices.tts_warmup_per_1k_chars * 100) / 100;
  return { items, chars, cost_cny: cost };
}
