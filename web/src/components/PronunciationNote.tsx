import type { ChatPron } from "@/lib/chat-pronunciation";

/**
 * 对话轮次的发音信息（task-57）—— **分角色展示**：
 *  - 家长：分数 + 最弱 1–2 个音 + 展开看逐词
 *  - 儿童：只有正向提示（**不显示任何分数**，避免打击；也绝不出现 IPA）
 *
 * 服务端/客户端都能渲染（纯展示，无 hooks），会话内与历史对话共用一份。
 */
export function PronunciationNote({
  pron,
  isChild,
  testid = "chat-pron",
}: {
  pron: ChatPron | null;
  isChild: boolean;
  testid?: string;
}) {
  if (isChild) {
    const good = typeof pron?.pron === "number" && pron.pron >= 70;
    const text = pron === null ? "这次的声音我听到啦，再跟我说一句吧 🙂" : good ? "这次说得很清楚，继续说！🌟" : "你勇敢开口了，我们慢慢来 🙂";
    return (
      <p className="mt-1 text-xs opacity-90" data-testid={testid} data-kind="child-positive">
        {text}
      </p>
    );
  }

  if (pron === null) {
    return (
      <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid={testid} data-kind="parent-failed">
        发音 <strong>—</strong>
        <span className="ml-2">（本轮评分未完成，不影响对话）</span>
      </p>
    );
  }

  const weak = (pron.weak_phonemes ?? []).map((w) => w.label).filter(Boolean);
  const words = (pron.words ?? []).filter((w) => w.word);
  return (
    <div className="mt-1" data-testid={testid} data-kind="parent-score" data-pron={pron.pron ?? ""}>
      <p className="text-xs">
        发音 <strong>{pron.pron ?? "—"}</strong>
        {weak.length > 0 ? (
          <>
            {" "}
            · 最弱 <strong>{weak.join(" / ")}</strong>
          </>
        ) : null}
      </p>
      {words.length > 0 ? (
        <details className="mt-1 text-xs text-[var(--ec-muted)]">
          <summary className="cursor-pointer">看逐词（{words.length} 个词）</summary>
          <p className="mt-1 flex flex-wrap gap-1">
            {words.map((w, i) => (
              <span key={`${w.word}-${i}`} className="rounded-full bg-[#eef0f8] px-2 py-0.5">
                {w.word} {typeof w.score === "number" ? w.score : "—"}
              </span>
            ))}
          </p>
        </details>
      ) : null}
    </div>
  );
}
