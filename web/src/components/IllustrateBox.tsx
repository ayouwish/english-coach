"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 故事插画（task-53）：调用 `/api/story/[id]/illustrate`（代理 voice 智谱出图）。
 *
 * - 默认**自动画一次**（进入详情且还没有图时）；生成中显示「正在画插画… 大约 10–30 秒」，**不阻塞其它操作**
 * - 失败可见原因：未启用 / 内容需要调整 / 服务出错，并给「再试一次」
 * - 「换一张」= force=1（**会再花一次费用**，旁边标注「每张约 ¥0.1」）
 * - 儿童文案：「给我画一张画」；零 IPA
 */
export function IllustrateBox({
  materialId,
  hasImage,
  isChild = false,
  autoTrigger = true,
  characterUsedInitial = false,
}: {
  materialId: string;
  hasImage: boolean;
  isChild?: boolean;
  autoTrigger?: boolean;
  /** 上次生成是否参考了虚拟形象（task-62） */
  characterUsedInitial?: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "done" | "error">(hasImage ? "done" : "idle");
  const [imageUrl, setImageUrl] = useState<string | null>(hasImage ? `/api/materials/${materialId}/image` : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [characterUsed, setCharacterUsed] = useState(characterUsedInitial);
  const startedRef = useRef(false);

  const generate = useCallback(
    async (force: boolean) => {
      setPhase("loading");
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/story/${encodeURIComponent(materialId)}/illustrate${force ? "?force=1" : ""}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        });
        const data = (await res.json().catch(() => null)) as
          | {
              image_url?: string;
              mime?: string;
              elapsed_ms?: number;
              character_used?: boolean;
              prompt_used?: string | null;
              error?: { code?: string; message?: string };
            }
          | null;
        if (!res.ok) {
          const code = data?.error?.code;
          setError(
            data?.error?.message ??
              (code === "content_unsafe"
                ? "这段话可能不适合画成图，换个说法试试"
                : `画插画失败（HTTP ${res.status}）`),
          );
          setPhase("error");
          return;
        }
        setImageUrl(`${data?.image_url ?? `/api/materials/${materialId}/image`}?t=${Date.now()}`);
        setCharacterUsed(Boolean(data?.character_used));
        setPhase("done");
        setNotice(
          force
            ? "换好了一张新插画 ✅"
            : typeof data?.elapsed_ms === "number"
              ? `画好啦 ✅（用了约 ${Math.round(data.elapsed_ms / 1000)} 秒）`
              : "画好啦 ✅",
        );
      } catch (err) {
        setError(`画插画失败：${(err as Error).message}。可以点「再试一次」。`);
        setPhase("error");
      }
    },
    [materialId],
  );

  useEffect(() => {
    if (!autoTrigger || hasImage || startedRef.current) return;
    startedRef.current = true;
    void generate(false);
  }, [autoTrigger, hasImage, generate]);

  return (
    <div className="mt-2" data-testid="illustration-box">
      {phase === "loading" || (phase === "done" && !imageUrl) ? (
        <div className="rounded-xl bg-[#f8f9ff] p-3" data-testid="illustration-loading">
          <div className="h-40 w-full max-w-sm animate-pulse rounded-lg bg-[#e6e8f5]" />
          <p className="mt-2 text-sm text-[var(--ec-muted)]">
            🎨 正在画插画… 大约 10–30 秒（可以先去读故事，画好了会出现在这里）
          </p>
        </div>
      ) : null}

      {imageUrl ? (
        <details className="mt-1" data-testid="illustration-image">
          <summary className="cursor-pointer">
            {/* eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片，无需 next/image */}
            <img
              src={imageUrl}
              alt="故事插画"
              data-testid="illustration-thumb"
              className="h-40 w-40 rounded-xl border border-[#e6e8f5] object-cover"
            />
          </summary>
          <div className="mt-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片，无需 next/image */}
            <img src={imageUrl} alt="故事插画（大图）" data-testid="illustration-large" className="w-full max-w-2xl rounded-xl" />
          </div>
        </details>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!imageUrl && phase !== "loading" ? (
          <button
            type="button"
            className="ec-btn ec-btn-primary"
            data-testid="illustration-generate"
            onClick={() => void generate(false)}
          >
            🖼️ {isChild ? "给我画一张画" : "生成插画"}
          </button>
        ) : null}
        {imageUrl ? (
          <>
            <button
              type="button"
              className="ec-btn ec-btn-ghost"
              data-testid="illustration-regenerate"
              disabled={phase === "loading"}
              onClick={() => void generate(true)}
            >
              {"🔁 "}
              {isChild ? "换一张画" : "换一张"}
            </button>
            <span className="text-xs text-[var(--ec-muted)]" data-testid="illustration-cost">
              每张约 ¥0.1（换一张会再花一次费用）
            </span>
          </>
        ) : null}
        {phase === "error" ? (
          <button
            type="button"
            className="ec-btn ec-btn-ghost"
            data-testid="illustration-retry"
            onClick={() => void generate(false)}
          >
            🔁 再试一次
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 rounded-xl bg-[#fff3d6] p-2 text-sm text-[#7a4d00]" role="alert" data-testid="illustration-error">
          {error}
        </p>
      ) : null}
      {characterUsed && imageUrl ? (
        <p className="mt-1 text-xs text-[#166534]" data-testid="illustration-character-used">
          ✅ 已按你的虚拟形象生成
        </p>
      ) : null}
      {notice ? (
        <p className="mt-2 text-xs text-[#166534]" data-testid="illustration-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
