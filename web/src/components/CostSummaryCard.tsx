import { costSummary } from "@/lib/cost";

const KIND_LABEL: Record<string, string> = {
  llm: "LLM 文本",
  image: "图片生成",
  tts: "语音合成",
  asr: "语音识别",
};

/** 家长面板「💰 本月成本」卡（task-101）：仅本家庭；金额按调用量估算，单价可配置。 */
export async function CostSummaryCard({ familyId }: { familyId: string }) {
  const summary = await costSummary(familyId);
  const yuan = (n: number) => `¥${n.toFixed(2)}`;
  const kinds = Object.entries(summary.by_kind).sort((a, b) => b[1] - a[1]);
  const days = summary.by_day.slice(-7);
  return (
    <section className="ec-card" data-testid="cost-card">
      <h2 className="text-base font-extrabold">💰 本月成本（{summary.month}）</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        按 voice 返回的实际用量估算，单价可配置（LLM 输入 ¥{summary.prices.llmInputPer1M}/百万 token、输出 ¥
        {summary.prices.llmOutputPer1M}/百万 token、图片 ¥{summary.prices.imagePerImage}/张）。
      </p>
      <p className="mt-2 text-2xl font-extrabold" data-testid="cost-total">
        {yuan(summary.total_cny)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {kinds.length === 0 ? (
          <span className="text-[var(--ec-muted)]" data-testid="cost-empty">
            本月还没有产生成本的调用。
          </span>
        ) : (
          kinds.map(([kind, cny]) => (
            <span key={kind} className="rounded-full bg-[var(--ec-primary-soft)] px-2 py-0.5" data-testid="cost-by-kind" data-kind={kind}>
              {KIND_LABEL[kind] ?? kind} {yuan(cny)}
            </span>
          ))
        )}
      </div>
      {summary.by_user.length > 0 ? (
        <div className="mt-3" data-testid="cost-by-user">
          <h3 className="text-sm font-semibold">成员明细</h3>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {summary.by_user.map((u) => (
              <li key={u.user_id ?? "unknown"} className="flex justify-between">
                <span>{u.display_name ?? "未知成员"}</span>
                <span className="tabular-nums">
                  {yuan(u.cny)} · {u.count} 次
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {days.length > 0 ? (
        <div className="mt-3" data-testid="cost-by-day">
          <h3 className="text-sm font-semibold">近 7 天</h3>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {days.map((d) => (
              <li key={d.date} className="flex justify-between">
                <span>{d.date}</span>
                <span className="tabular-nums">{yuan(d.cny)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
