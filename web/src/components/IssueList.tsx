"use client";

import { getChildHint, getHint } from "@/lib/hints";
import type { PronounceIssue } from "@/lib/types";

const SEVERITY_STYLE: Record<string, string> = {
  high: "border-red-200 bg-red-50",
  medium: "border-amber-200 bg-amber-50",
  low: "border-slate-200 bg-slate-50",
};

/**
 * 问题卡片：只展示前 2 条（契约 §3.1 教学原则：一次别纠太多）。
 * 儿童模式不显示任何 IPA 符号，只用「音」和口型描述。
 */
export function IssueList({
  issues,
  isChild,
  phonemeLevel,
}: {
  issues: PronounceIssue[];
  isChild: boolean;
  phonemeLevel: boolean;
}) {
  const top = (issues ?? []).slice(0, 2);
  if (top.length === 0) {
    return (
      <p className="text-sm text-[var(--ec-muted)]" data-testid="issues-empty">
        这次没有需要纠正的重点，保持就好 👍
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="issue-list">
      {top.map((issue, i) => {
        const hint = getHint(issue.hint_key);
        const child = getChildHint(issue.hint_key);
        const showIpa = !isChild && phonemeLevel;
        return (
          <article
            key={`${issue.word}-${issue.phoneme ?? i}`}
            className={`rounded-xl border p-3 ${SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.low} ec-pop`}
          >
            <h4 className="font-bold">
              {isChild ? "🌱 " : ""}
              {isChild ? child.title : hint.title_zh}
              <span className="ml-2 text-sm font-normal text-[var(--ec-muted)]">
                单词：{issue.word}
                {showIpa && issue.phoneme ? ` · 音素 ${issue.phoneme}` : ""}
                {showIpa && issue.actual ? ` → 实际读成 ${issue.actual}` : ""}
                {showIpa && issue.score !== null && issue.score !== undefined
                  ? ` · ${Math.round(issue.score)} 分`
                  : ""}
              </span>
            </h4>
            <p className="mt-1 text-sm">
              <strong>为什么：</strong>
              {isChild ? child.why : hint.why_zh}
            </p>
            <p className="mt-1 text-sm">
              <strong>怎么做：</strong>
              {isChild ? child.how : hint.how_zh}
            </p>
            {hint.practice_words.length > 0 ? (
              <p className="mt-1 text-sm text-[var(--ec-muted)]">
                练习词：{hint.practice_words.join(" · ")}
              </p>
            ) : null}
            {!phonemeLevel ? (
              <p className="mt-1 text-xs text-[var(--ec-muted)]">
                ⚠️ 单词级粗评（provider 不支持音素级）
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
