"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Articulation } from "@/lib/articulation";
import { buildArticulationSvg, describeArticulation } from "@/lib/articulation-svg";

/**
 * 口型动画微课（task-16 D）。
 * - 参数化 SVG：同一个渲染器画任意音素；`compareWith` 时并排画两个音并高亮差异点
 * - 循环教学动作：舌头在"中性位置 ↔ 目标位置"之间循环（可暂停）
 * - 性能/无障碍：`IntersectionObserver` 只在可见时动画；`prefers-reduced-motion` 降级为静态帧
 * - 首屏（SSR）输出的是**静态目标帧**，所以无 JS 也能看到正确的口型剖面
 */
export function ArticulationDemo({
  primary,
  compareWith = null,
  compareNote = null,
  isChild = false,
  size = 300,
}: {
  primary: Articulation;
  compareWith?: Articulation | null;
  compareNote?: string | null;
  isChild?: boolean;
  size?: number;
}) {
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const animated = playing && visible && !reducedMotion;

  const primarySvg = useMemo(
    () =>
      buildArticulationSvg(primary, {
        isChild,
        // SSR 首屏是静态帧（visible=false）；进入视口且未暂停时重新生成为带动画版本
        animated,
        highlightDiff: Boolean(compareWith),
        compareNote,
        size,
      }),
    [primary, isChild, compareWith, compareNote, size, animated],
  );

  const compareSvg = useMemo(
    () =>
      compareWith
        ? buildArticulationSvg(compareWith, {
            isChild,
            animated,
            highlightDiff: false,
            size,
          })
        : null,
    [compareWith, isChild, size, animated],
  );

  // 用 CSS 变量的方式让"播放/暂停"作用于 SVG 内部的 .art-anim 规则
  const figure = (svg: string, label: string, testid: string) => (
    <figure className="flex flex-col items-center" data-testid={testid}>
      <div
        className="w-full [&>svg]:h-auto [&>svg]:w-full"
        // 内容由 buildArticulationSvg 从数值参数生成，标签经过转义，无用户输入
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <figcaption className={`mt-1 font-semibold ${isChild ? "text-base" : "text-xs"}`}>{label}</figcaption>
    </figure>
  );

  return (
    <div
      ref={holderRef}
      data-testid="articulation-demo"
      data-compare={compareWith ? "1" : "0"}
      data-animated={animated ? "1" : "0"}
      className="rounded-xl bg-white p-3"
    >
      <div className={`flex flex-wrap items-start justify-center gap-4 ${compareWith ? "" : "max-w-[340px] mx-auto"}`}>
        {figure(
          primarySvg,
          isChild ? primary.childLabel : primary.ipa,
          "articulation-primary",
        )}
        {compareSvg && compareWith
          ? figure(compareSvg, isChild ? compareWith.childLabel : compareWith.ipa, "articulation-compare")
          : null}
      </div>

      <p data-testid="articulation-desc" className="mt-2 text-xs text-[var(--ec-muted)]">
        {describeArticulation(primary, isChild)}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="ec-btn ec-btn-ghost"
          data-testid="articulation-toggle"
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "⏸ 暂停动画" : "▶ 播放动画"}
        </button>
        {reducedMotion ? (
          <span className="text-xs text-[var(--ec-muted)]">已按系统偏好显示静态图（prefers-reduced-motion）</span>
        ) : null}
      </div>
    </div>
  );
}
