"use client";

import { useState } from "react";
import { Recorder } from "@/components/Recorder";

interface RetellResult {
  coverage: number | null;
  covered_points: string[];
  missing_points: string[];
  feedback_zh: string;
  feedback_en: string;
}

/**
 * P3 复述（task-50）：「不看屏幕，用 2–3 句话把故事讲一遍」。
 *
 * 流程：录音 → /api/asr（英文）→ POST /api/story/retell（代理 voice）→
 * **先鼓励**（你讲到了哪些点）→ **再给一条具体建议**（缺哪个关键点）。
 *
 * 约束：**不显示任何发音分数**（复述重点是表达）；voice 未就绪时给出可读降级提示。
 * 同一个组件被 /flow 汇总处与 /story/[id] 详情页复用（不复制）。
 */
export function RetellPanel({
  materialId,
  storySentences,
  level = "A2",
  isChild = false,
  onSaved,
}: {
  materialId?: string | null;
  storySentences: string[];
  level?: string;
  isChild?: boolean;
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetellResult | null>(null);
  const [times, setTimes] = useState(0);

  async function handleRecording(blob: Blob) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // ① 转写（英文）
      const form = new FormData();
      form.append("audio", blob, `retell.${blob.type.includes("wav") ? "wav" : "webm"}`);
      form.append("language", "en-US");
      const asrRes = await fetch("/api/asr", { method: "POST", body: form });
      const asr = (await asrRes.json().catch(() => null)) as
        | { text?: string; error?: { message?: string } }
        | null;
      if (!asrRes.ok || !asr?.text) {
        setError(asr?.error?.message ?? `没听清你的复述（HTTP ${asrRes.status}），再讲一次吧`);
        return;
      }
      // ② 覆盖度评估
      const res = await fetch("/api/story/retell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          material_id: materialId ?? null,
          story_sentences: storySentences,
          transcript: asr.text,
          level,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (RetellResult & { error?: { message?: string } })
        | null;
      if (!res.ok) {
        setError(data?.error?.message ?? `复述评估失败（HTTP ${res.status}）`);
        return;
      }
      setResult({
        coverage: data?.coverage ?? null,
        covered_points: data?.covered_points ?? [],
        missing_points: data?.missing_points ?? [],
        feedback_zh: data?.feedback_zh ?? "",
        feedback_en: data?.feedback_en ?? "",
      });
      setTimes((n) => n + 1);
      onSaved?.();
    } catch (err) {
      setError(`复述评估失败：${(err as Error).message}。可以再讲一次。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl bg-[#f8f9ff] p-3" data-testid="retell-panel">
      <p className="text-sm font-extrabold">🎤 {isChild ? "讲给我听" : "复述：讲给我听"}</p>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        {isChild
          ? "先别看屏幕，用 2–3 句话把这个故事讲一遍 🙂 讲错了也没关系。"
          : "不看屏幕，用 2–3 句话把故事讲一遍（重点是表达，不计发音分）。"}
      </p>
      <div className="mt-2">
        <Recorder onRecorded={(blob) => void handleRecording(blob)} disabled={busy} isChild={isChild} />
      </div>
      {times > 0 ? (
        <p className="mt-2 text-xs text-[var(--ec-muted)]" data-testid="retell-times">
          你已经复述了 {times} 次
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 rounded-xl bg-white p-3" data-testid="retell-result">
          {/* 先鼓励：讲到了哪些点 */}
          <p className="text-sm font-extrabold" data-testid="retell-praise">
            {isChild ? "你真棒！" : "很好！"}{" "}
            {result.covered_points.length > 0
              ? `你讲到了 ${result.covered_points.length} 个关键点`
              : "你开口把故事讲出来了"}
            {reportCoverage(result.coverage)}
          </p>
          {result.covered_points.length > 0 ? (
            <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="retell-covered">
              讲到了：{result.covered_points.join(" / ")}
            </p>
          ) : null}
          {/* 再给一条建议 */}
          <p className="mt-2 text-sm" data-testid="retell-suggestion">
            下一次可以试试：{result.missing_points.length > 0 ? `把「${result.missing_points[0]}」也讲进去` : "再多说一句细节"}
          </p>
          {result.feedback_zh ? (
            <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="retell-feedback-zh">
              {result.feedback_zh}
            </p>
          ) : null}
          {result.feedback_en ? (
            <p className="mt-1 text-xs text-[var(--ec-muted)]">{result.feedback_en}</p>
          ) : null}
          <p className="mt-2 text-xs text-[var(--ec-muted)]">复述只看「讲清楚没有」，不计发音分。</p>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-xl bg-[#fff3d6] p-2 text-sm text-[#7a4d00]" role="alert" data-testid="retell-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function reportCoverage(coverage: number | null): string {
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return "";
  return `（覆盖度 ${Math.round(coverage * 100)}%）`;
}
