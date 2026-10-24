"use client";

import type { PronounceScores } from "@/lib/types";

const ITEMS: { key: keyof PronounceScores; label: string; childLabel: string }[] = [
  { key: "accuracy", label: "准确度", childLabel: "说得准不准" },
  { key: "fluency", label: "流利度", childLabel: "顺不顺" },
  { key: "completeness", label: "完整度", childLabel: "有没有漏词" },
  { key: "prosody", label: "韵律", childLabel: "节奏好不好" },
];

export function ScoreBars({
  scores,
  isChild,
  capabilities,
}: {
  scores: PronounceScores;
  isChild: boolean;
  capabilities: { prosody: boolean; phoneme_level: boolean };
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="score-bars">
      {ITEMS.map((item) => {
        const raw = scores[item.key];
        const value = raw === null || raw === undefined ? null : Math.round(raw);
        const unmet = item.key === "prosody" && !capabilities.prosody;
        return (
          <div key={item.key} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-[var(--ec-muted)]">
              {isChild ? item.childLabel : item.label}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[#eef0f8]">
              <span
                className="block h-full rounded-full transition-all"
                style={{
                  width: `${value ?? 0}%`,
                  background:
                    value === null ? "#cbd0e6" : value >= 80 ? "#16a34a" : value >= 60 ? "#f59e0b" : "#ef4444",
                }}
              />
            </span>
            <span className="w-12 text-right font-semibold">
              {value === null ? (unmet ? "暂不可用" : "—") : value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TotalScore({ value, isChild }: { value: number | null; isChild: boolean }) {
  const effective = value === null ? null : Math.round(value);
  const tone =
    effective === null ? "#6b7290" : effective >= 85 ? "#16a34a" : effective >= 70 ? "#0ea5e9" : effective >= 60 ? "#f59e0b" : "#ef4444";
  return (
    <div className="ec-pop flex items-center gap-4">
      <div
        className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-full border-4"
        style={{ borderColor: tone, color: tone }}
        data-testid="total-score"
      >
        <span className="text-3xl font-extrabold leading-none">
          {effective === null ? "—" : effective}
        </span>
        <span className="text-[10px] tracking-wide">{isChild ? "总分" : "综合分"}</span>
      </div>
      <div className="text-sm">
        <p className="text-lg font-bold">
          {effective === null
            ? "评测服务暂不可用 ⏳"
            : effective >= 85
              ? isChild
                ? "太棒啦！🌟"
                : "非常棒 🌟"
              : effective >= 70
                ? isChild
                  ? "很好，继续加油！🎉"
                  : "不错 🎉"
                : isChild
                  ? "再来一次会更好哦 💪"
                  : "还可以再练一练 💪"}
        </p>
        <p className="text-[var(--ec-muted)]">综合分 = pron（契约 §3.1 口径，由 voice 计算）</p>
      </div>
    </div>
  );
}
