"use client";

import { useEffect, useState } from "react";

interface ScopedItem {
  phoneme: string;
  child_label: string;
  status: "weak" | "watch" | "ok";
  avg_score: number;
  attempts: number;
  error_words: { word: string; score: number | null }[];
}

interface ScopedPayload {
  scope: string;
  summary_zh: string;
  items: ScopedItem[];
  range: { attempt_count: number };
  error?: { message?: string };
}

/**
 * 「这一句 / 这一批的问题」（task-71 C）：作用域诊断小卡。
 *
 * 只统计传入 attempt（服务端强制本人校验），和总体诊断分开；儿童不显示 IPA。
 */
export function ScopedDiagnosisCard({
  scope,
  attemptIds,
  label,
  isChild = false,
}: {
  scope: "attempt" | "batch";
  attemptIds: string[];
  label?: string;
  isChild?: boolean;
}) {
  const [data, setData] = useState<ScopedPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (attemptIds.length === 0) {
      setLoading(false);
      setData({ scope, summary_zh: scope === "attempt" ? "这一句还没评分" : "这一批还没评分", items: [], range: { attempt_count: 0 } });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ scope });
    if (scope === "attempt") qs.set("attempt_id", attemptIds[0]);
    else qs.set("attempt_ids", attemptIds.join(","));
    (async () => {
      try {
        const res = await fetch(`/api/diagnosis?${qs.toString()}`);
        const body = (await res.json().catch(() => null)) as ScopedPayload | null;
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error?.message ?? `读取${scope === "attempt" ? "这一句" : "这一批"}的诊断失败（HTTP ${res.status}）`);
          return;
        }
        setData(body);
      } catch (err) {
        if (!cancelled) setError(`读取诊断失败：${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, attemptIds, isChild]);

  const items = data?.items ?? [];
  const problems = items.filter((i) => i.status !== "ok");

  return (
    <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid={`scoped-diagnosis-${scope}`}>
      <p className="text-sm font-semibold">{label ?? (scope === "attempt" ? "这一句的问题" : "这一批的问题")}</p>
      {loading ? <p className="mt-1 text-xs text-[var(--ec-muted)]">正在统计…</p> : null}
      {error ? (
        <p className="mt-1 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]" role="alert">
          {error}
        </p>
      ) : null}
      {data && !loading ? (
        <>
          <p className="mt-1 text-sm" data-testid="scoped-diagnosis-summary">
            {data.summary_zh}
          </p>
          {items.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {items.slice(0, 5).map((it, idx) => (
                <li
                  key={`${it.phoneme}-${idx}`}
                  className={`rounded-full px-2 py-0.5 ${it.status === "weak" ? "bg-[#ffe3e3] text-[#991b1b]" : it.status === "watch" ? "bg-[#fff3d6] text-[#7a4d00]" : "bg-[#e8f7ee] text-[#166534]"}`}
                >
                  {isChild ? it.child_label : `/${it.phoneme}/`} · {it.avg_score}
                  {it.error_words?.[0] ? `（${it.error_words[0].word}）` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {problems.length === 0 && items.length > 0 ? (
            <p className="mt-1 text-xs text-[#166534]">{scope === "attempt" ? "这一句读得不错" : "这一批读得不错"}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
