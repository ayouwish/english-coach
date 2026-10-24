import { buildRadarSvg, formatScore, lowestAxis, RADAR_AXES, type RadarScores } from "@/lib/radar";

/**
 * 能力多边形（雷达图）—— task-14 B。
 * - 纯内联 SVG（由 src/lib/radar.ts 生成，无图表库）
 * - `null` 轴标 "—" 且不参与多边形（契约 §3.1：不可得必须是 null，不能当 0）
 * - 四个数值同时以文字列出（不能只靠图形表达）
 * - 额外给出"最需要练的是 X"（雷达图面积受轴顺序影响，需要显式文字兜底）
 */
export function ScoreRadar({ scores, isChild }: { scores: RadarScores; isChild: boolean }) {
  const low = lowestAxis(scores);
  const svg = buildRadarSvg(scores, { isChild });

  return (
    <div data-testid="score-radar-wrap">
      {/* 内容全部由 radar.ts 生成：只有数值与固定轴标签，没有用户输入 */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />

      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="radar-values">
        {RADAR_AXES.map((axis) => {
          const v = scores[axis.key];
          const isNull = v === null || !Number.isFinite(v as number);
          return (
            <li key={axis.key} data-axis={axis.key} data-value={isNull ? "null" : formatScore(v, isChild)}>
              <span className="text-[var(--ec-muted)]">{isChild ? axis.childLabel : axis.label}：</span>
              <strong>{formatScore(v, isChild)}</strong>
              {isNull ? (
                <span className="ml-1 text-xs text-[var(--ec-muted)]">（该 provider 不支持，未计入多边形）</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-sm font-semibold" data-testid="radar-lowest">
        {low
          ? `${isChild ? "最需要练的是" : "最需要练的是"} ${low.label} ${formatScore(low.value, isChild)}`
          : "暂无可用分项"}
      </p>
    </div>
  );
}
