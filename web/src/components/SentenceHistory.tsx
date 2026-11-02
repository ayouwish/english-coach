"use client";

import { useEffect, useMemo, useState } from "react";

interface AttemptRow {
  id: string;
  created_at: string;
  scores: { pron?: number | null } | null;
  audio_url: string | null;
}

interface HistoryPayload {
  sentence: { id: string; text: string };
  attempts: AttemptRow[];
  error?: { message?: string };
}

/**
 * 单句历史 + 进步曲线（task-84）：`GET /api/sentences/:id/attempts`（仅本人）。
 * - ≥2 次才画 SVG 折线（x=时间，y=发音分），并显示首末对比
 * - 儿童只看鼓励，不显示分数
 */
export function SentenceHistory({
  sentenceId,
  isChild = false,
  refreshKey = 0,
}: {
  sentenceId: string;
  isChild?: boolean;
  /** 变化时重新拉取（练完一句后刷新曲线） */
  refreshKey?: number;
}) {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/sentences/${encodeURIComponent(sentenceId)}/attempts?limit=20`);
        const body = (await res.json().catch(() => null)) as HistoryPayload | null;
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error?.message ?? `读取历史失败（HTTP ${res.status}）`);
          return;
        }
        setData(body);
      } catch (err) {
        if (!cancelled) setError(`读取历史失败：${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sentenceId, refreshKey]);

  const scored = useMemo(
    () => (data?.attempts ?? []).filter((a) => typeof a.scores?.pron === "number").map((a) => ({ ...a, pron: a.scores!.pron as number })),
    [data],
  );

  if (loading) {
    return (
      <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3 text-xs text-[var(--ec-muted)]" data-testid="sentence-history">
        正在读取这一句的历史…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-3 rounded-xl bg-[#fff3d6] p-3 text-xs text-[#7a4d00]" data-testid="sentence-history" role="alert">
        {error}
      </div>
    );
  }

  const count = data?.attempts.length ?? 0;
  const first = scored.length > 0 ? scored[scored.length - 1] : null;
  const last = scored.length > 0 ? scored[0] : null;
  const delta = first && last && first.pron !== last.pron ? Math.round((last.pron - first.pron) * 10) / 10 : null;

  return (
    <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="sentence-history">
      <p className="text-sm font-semibold">📈 这一句的历史（{count} 次）</p>
      {count === 0 ? (
        <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="sentence-history-empty">
          这是第一次练这句，多读几次就能看到曲线。
        </p>
      ) : null}
      {scored.length >= 2 ? (
        <div className="mt-2" data-testid="sentence-history-curve">
          <ProgressCurve points={scored.map((a) => a.pron)} />
          {!isChild && first && last ? (
            <p className="mt-1 text-xs" data-testid="sentence-history-delta">
              首末对比：{first.pron} → {last.pron}
              {delta !== null ? `（${delta > 0 ? "+" : ""}${delta}）` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      {count > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {(data?.attempts ?? []).slice(0, 10).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
              <span className="text-[var(--ec-muted)]">{new Date(a.created_at).toLocaleString("zh-CN")}</span>
              {isChild ? (
                <span>读过了</span>
              ) : (
                <span className="rounded-full bg-white px-2 py-0.5">{typeof a.scores?.pron === "number" ? `${a.scores.pron} 分` : "—"}</span>
              )}
              {a.audio_url ? <audio controls preload="metadata" src={a.audio_url} className="h-7 w-40" data-testid="sentence-history-audio" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** SVG 折线：x 均匀分布，y 按分数缩放（60–100 → 高度） */
function ProgressCurve({ points }: { points: number[] }) {
  const w = 260;
  const h = 70;
  const pad = 8;
  const min = Math.min(...points, 60);
  const max = Math.max(...points, 100);
  const span = Math.max(1, max - min);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => [pad + i * step, h - pad - ((p - min) / span) * (h - pad * 2)] as const);
  const d = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full max-w-[320px]" role="img" aria-label="发音分进步曲线" data-testid="sentence-history-svg">
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="var(--ec-primary)" strokeWidth="2" />
      <path d={d} fill="none" stroke="transparent" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill="var(--ec-primary)" />
      ))}
    </svg>
  );
}
