/**
 * 能力多边形（雷达图）—— 纯 SVG 字符串生成，不依赖任何图表库。
 *
 * 契约 §3.1：`scores.*` 不可得时必须是 `null`（不是 0）。
 * 所以 **null 轴不参与多边形**（画成 0 等于编造低分），并且在图上明确标 "—"。
 *
 * 这个模块刻意做成"无依赖纯函数"，好处：
 *   1) 组件与自测脚本用同一份实现（scripts/check-practice-ui.mjs 直接 import 本文件）；
 *   2) SVG 里只有数值与固定轴标签，没有任何用户输入 → 不存在注入面。
 */

export interface RadarScores {
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
}

export interface RadarOptions {
  size?: number;
  isChild?: boolean;
}

export const RADAR_AXES: { key: keyof RadarScores; label: string; childLabel: string }[] = [
  { key: "accuracy", label: "准确", childLabel: "说得准" },
  { key: "fluency", label: "流利", childLabel: "说得顺" },
  { key: "completeness", label: "完整", childLabel: "没漏词" },
  { key: "prosody", label: "节奏", childLabel: "节奏" },
];

const RINGS = [25, 50, 75, 100];

function clamp01to100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** 轴角度：准确在正上方，顺时针排列 */
function axisAngle(index: number): number {
  return (-90 + index * 90) * (Math.PI / 180);
}

/** 数值格式化：儿童不显示小数 */
export function formatScore(v: number | null, isChild = false): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return isChild ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

/** 最低分项（忽略 null；全为 null 时返回 null）—— 雷达图面积受轴顺序影响，故必须有这句文字兜底 */
export function lowestAxis(scores: RadarScores): { key: keyof RadarScores; label: string; value: number } | null {
  let best: { key: keyof RadarScores; label: string; value: number } | null = null;
  for (const axis of RADAR_AXES) {
    const v = scores[axis.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!best || v < best.value) best = { key: axis.key, label: axis.label, value: v };
  }
  return best;
}

/**
 * 生成雷达图 SVG。
 * @returns SVG 字符串；null 轴画虚线轴 + "—"，且不进多边形/不画顶点。
 */
export function buildRadarSvg(scores: RadarScores, options: RadarOptions = {}): string {
  const size = options.size ?? 240;
  const isChild = Boolean(options.isChild);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.32;
  const labelR = maxR + (isChild ? 26 : 22);
  const labelSize = isChild ? 15 : 12;
  const valueSize = isChild ? 15 : 11.5;

  const point = (index: number, radius: number): [number, number] => {
    const a = axisAngle(index);
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
  };
  const f = (n: number) => Math.round(n * 100) / 100;

  const parts: string[] = [];
  parts.push(
    `<svg role="img" aria-label="能力多边形：准确、流利、完整、节奏" ` +
      `viewBox="0 0 ${size} ${size}" width="100%" height="${size}" data-testid="score-radar" ` +
      `xmlns="http://www.w3.org/2000/svg">`,
  );

  // 同心网格环
  for (const ring of RINGS) {
    const r = (ring / 100) * maxR;
    const pts = RADAR_AXES.map((_, i) => point(i, r).map(f).join(",")).join(" ");
    parts.push(
      `<polygon points="${pts}" fill="${ring === 100 ? "rgba(91,91,214,0.03)" : "none"}" ` +
        `stroke="${ring === 100 ? "#c7c9f2" : "#e6e8f5"}" stroke-width="1" data-ring="${ring}" />`,
    );
  }
  // 环刻度数值（只标一条右上方向的 100，避免糊）
  parts.push(
    `<text x="${f(cx + 4)}" y="${f(cy - maxR + 11)}" font-size="9" fill="#9aa0bb">100</text>`,
  );

  // 轴线
  RADAR_AXES.forEach((axis, i) => {
    const [x, y] = point(i, maxR);
    const isNull = scores[axis.key] === null || !Number.isFinite(scores[axis.key] as number);
    parts.push(
      `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(x)}" y2="${f(y)}" ` +
        `stroke="${isNull ? "#cbd0e6" : "#d9dcf0"}" stroke-width="1" ` +
        `${isNull ? 'stroke-dasharray="4 3"' : ""} data-axis-line="${axis.key}" />`,
    );
  });

  // 分数多边形：只连"有值"的轴（null 不参与）
  const scored = RADAR_AXES.map((axis, i) => ({ axis, i, v: scores[axis.key] })).filter(
    (x): x is { axis: (typeof RADAR_AXES)[number]; i: number; v: number } =>
      typeof x.v === "number" && Number.isFinite(x.v),
  );
  if (scored.length >= 2) {
    const pts = scored
      .map(({ i, v }) => point(i, (clamp01to100(v) / 100) * maxR).map(f).join(","))
      .join(" ");
    parts.push(
      `<polygon points="${pts}" fill="rgba(91,91,214,0.22)" stroke="#5b5bd6" stroke-width="2" data-testid="radar-polygon" />`,
    );
  }
  scored.forEach(({ i, v }) => {
    const [x, y] = point(i, (clamp01to100(v) / 100) * maxR);
    parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${isChild ? 4 : 3}" fill="#5b5bd6" />`);
  });

  // 轴标签 + 数值（数值也写进图里，不只靠图形表达）
  RADAR_AXES.forEach((axis, i) => {
    const [lx, ly] = point(i, labelR);
    const v = scores[axis.key];
    const isNull = v === null || !Number.isFinite(v as number);
    const anchor = i === 0 || i === 2 ? "middle" : i === 1 ? "start" : "end";
    const dy = i === 0 ? -4 : i === 2 ? 14 : 4;
    const shown = formatScore(v, isChild);
    parts.push(
      `<g data-axis="${axis.key}" data-value="${isNull ? "null" : shown}">` +
        `<text x="${f(lx)}" y="${f(ly + dy)}" font-size="${labelSize}" font-weight="${isChild ? 700 : 600}" ` +
        `text-anchor="${anchor}" fill="#1b1f3b">${isChild ? axis.childLabel : axis.label}</text>` +
        `<text x="${f(lx)}" y="${f(ly + dy + labelSize + 1)}" font-size="${valueSize}" ` +
        `text-anchor="${anchor}" fill="${isNull ? "#9aa0bb" : "#5b5bd6"}">${shown}</text>` +
        `</g>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join("");
}
