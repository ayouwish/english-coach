"use client";

import { useEffect, useRef } from "react";
import type { F0Point, WorstRegion } from "@/lib/types";

interface Props {
  userF0: F0Point[];
  referenceF0: F0Point[];
  worstRegions?: WorstRegion[];
  dtwDistance?: number | null;
  isChild?: boolean;
  height?: number;
}

/**
 * F0 双曲线对比图（契约 §3.1：两条曲线同时间轴、同长度，20ms 步长）。
 * 手写 canvas，不引入图表库。语调曲线不依赖云 API，是降级模式下最有价值的反馈，
 * 因此只要 intonation.available=true 就照常渲染 —— 即使 phoneme_level=false。
 */
export function F0Chart({
  userF0,
  referenceF0,
  worstRegions = [],
  dtwDistance = null,
  isChild = false,
  height = 220,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const cssWidth = canvas.clientWidth || 640;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);

    const padL = 44;
    const padR = 14;
    const padT = 16;
    const padB = 30;
    const w = cssWidth - padL - padR;
    const h = height - padT - padB;

    const all = [...userF0, ...referenceF0].filter((p) => p[1] !== null) as [number, number][];
    if (all.length === 0) {
      ctx.fillStyle = "#6b7290";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("（本次没有可用的音高数据）", padL, height / 2);
      return;
    }

    const rawMin = Math.min(...all.map((p) => p[1]));
    const rawMax = Math.max(...all.map((p) => p[1]));
    const span = Math.max(30, rawMax - rawMin);
    const yMin = rawMin - span * 0.15;
    const yMax = rawMax + span * 0.15;
    const maxT = Math.max(...all.map((p) => p[0]), 1);

    const x = (t: number) => padL + (t / maxT) * w;
    const y = (f: number) => padT + h - ((f - yMin) / (yMax - yMin)) * h;

    // 网格
    ctx.strokeStyle = "#e6e8f5";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const yy = padT + (h * i) / 3;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + w, yy);
      ctx.stroke();
      const hz = yMax - ((yMax - yMin) * i) / 3;
      ctx.fillStyle = "#9aa0bb";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(`${Math.round(hz)}Hz`, 4, yy + 4);
    }

    // 最差区间高亮
    ctx.fillStyle = "rgba(239,68,68,0.12)";
    for (const r of worstRegions) {
      const x0 = x(Math.max(0, r.start_ms));
      const x1 = x(Math.min(maxT, r.end_ms));
      ctx.fillRect(x0, padT, Math.max(2, x1 - x0), h);
    }

    const drawLine = (points: F0Point[], color: string, dashed: boolean, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      let penDown = false;
      for (const [t, f] of points) {
        if (f === null || !Number.isFinite(f)) {
          penDown = false;
          continue;
        }
        const px = x(t);
        const py = y(f);
        if (!penDown) {
          ctx.moveTo(px, py);
          penDown = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawLine(referenceF0, "#7c86c8", true, 2);
    drawLine(userF0, "#5b5bd6", false, isChild ? 4 : 2.5);

    // 时间轴
    ctx.fillStyle = "#9aa0bb";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("0s", padL, height - 10);
    ctx.fillText(`${(maxT / 1000).toFixed(1)}s`, padL + w - 26, height - 10);

    if (dtwDistance !== null) {
      ctx.fillStyle = "#6b7290";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(`语调差异 ${dtwDistance.toFixed(2)}（越小越接近）`, padL + 4, padT + 12);
    }
  }, [userF0, referenceF0, worstRegions, dtwDistance, isChild, height]);

  return (
    <div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height }}
        data-testid="f0-chart"
        aria-label="音调（F0）双曲线对比图"
      />
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-[var(--ec-muted)]">
        <span>
          <span className="mr-1 inline-block h-2 w-4 rounded bg-[#5b5bd6]" />
          {isChild ? "你的声音高低" : "你的音调"}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-4 rounded bg-[#7c86c8]" />
          {isChild ? "示范音的高低" : "示范音调"}
        </span>
        {worstRegions.length > 0 ? (
          <span>
            <span className="mr-1 inline-block h-2 w-4 rounded bg-[#ef4444]/30" />
            需要调整的片段
          </span>
        ) : null}
      </div>
    </div>
  );
}
