import Link from "next/link";
import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { listBlindTests } from "@/lib/blind-test";

export const dynamic = "force-dynamic";

/**
 * /blindtest/report —— 盲测周报（结束后才可见分数，契约 §13.3 第 3 条）。
 * 家长判断“到底有没有变好”的依据；家长面板 /parent 也会展示同样的数据。
 */
export default async function BlindTestReportPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await listBlindTests(user.id);
  const isChild = user.isChild;
  const current = data.trend.current;
  const previous = data.trend.previous;
  const delta = data.trend.delta_pron;
  const series = data.series.filter((s) => s.avg_pron !== null);

  const maxScore = Math.max(100, ...series.map((s) => s.avg_pron ?? 0));
  const barW = 44;
  const gap = 16;
  const chartW = Math.max(280, series.length * (barW + gap) + 20);
  const chartH = 150;

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">
          {isChild ? "📈 我的进步周报" : "📈 盲测周报（Blind Test）"}
        </h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          同一组句子、全程无反馈的成绩对比 —— 这是“真的学会了”的唯一证据。
          {isChild ? " 每次小测验都会记在这里，看看自己有没有进步吧！" : ""}
        </p>
      </section>

      {(data.pending_total ?? 0) > 0 ? (
        <section className="ec-card" data-testid="blind-pending-banner">
          <p className="rounded-xl bg-[#fff3d6] p-3 text-sm">
            ⏳ 还有<strong> {data.pending_total} 条</strong>暂时显示为<strong>待评分</strong>
            （后台<strong>评分中</strong>；盲测是异步评分的，不需要等它）。报告里的平均分只基于<strong>已评完</strong>的记录，不会被待评分条目拉低。
          </p>
        </section>
      ) : null}

      {data.in_progress ? (
        <section className="ec-card">
          <p className="rounded-xl bg-[#fff3d6] p-3 text-sm">
            有一次盲测还没结束（{data.in_progress.item_count} 句，已评分 {data.in_progress.scored ?? 0} 条）
            —— 结束之前不会显示分数，这样才测得准。
          </p>
          {(data.in_progress.pending ?? 0) > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="blind-pending-items">
              {Array.from({ length: data.in_progress.pending ?? 0 }).map((_, i) => (
                <li key={i} className="flex items-center gap-2 text-[var(--ec-muted)]">
                  <span aria-hidden>•</span>
                  <span data-testid="blind-pending-item">
                    第 {data.in_progress!.scored + i + 1} 句：<strong>评分中</strong>
                    （若服务重启过会显示「评分失败（服务重启）」，该句不计入平均分）
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <Link href="/blindtest" className="ec-btn ec-btn-primary mt-3">
            继续这次盲测
          </Link>
        </section>
      ) : null}

      {current ? (
        <section className="ec-card ec-pop" data-testid="blind-current">
          <div className="flex flex-wrap items-end gap-6">
            <div>
              <p className="text-xs text-[var(--ec-muted)]">最近一次盲测</p>
              <p className="text-5xl font-extrabold leading-none">
                {current.avg_pron === null ? "—" : current.avg_pron}
                <span className="ml-1 text-base font-medium text-[var(--ec-muted)]">分</span>
              </p>
              <p className="mt-1 text-xs text-[var(--ec-muted)]">
                {current.ended_at ? new Date(current.ended_at).toLocaleString("zh-CN") : ""}
                {current.avg_pron === null ? " · 这条还没有已评分的记录" : " · 仅统计已评分记录"}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--ec-muted)]">与上一次相比</p>
              <p
                className="text-3xl font-extrabold"
                style={{
                  color: delta === null ? "#6b7290" : delta > 0 ? "#16a34a" : delta < 0 ? "#ef4444" : "#6b7290",
                }}
                data-testid="blind-delta"
              >
                {delta === null ? "首次" : `${delta > 0 ? "▲ +" : delta < 0 ? "▼ " : "＝ "}${delta}`}
                {delta === null ? "" : <span className="ml-1 text-base font-medium">分</span>}
              </p>
              <p className="mt-1 text-xs text-[var(--ec-muted)]">
                上次：{previous?.avg_pron === null || previous === null ? "无" : `${previous.avg_pron} 分`}
              </p>
            </div>
            <div className="text-sm">
              <p className="text-[var(--ec-muted)]">
                准确度 {current.avg_accuracy ?? "—"} · 流利度 {current.avg_fluency ?? "—"} · 语调差异{" "}
                {current.avg_intonation_distance ?? "—"}
              </p>
              <p className="mt-1 text-[var(--ec-muted)]">已完成盲测 {data.trend.weeks} 次</p>
            </div>
          </div>

          {series.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <h3 className="text-sm font-bold text-[var(--ec-muted)]">历次盲测（越靠右越近）</h3>
              <svg
                width={chartW}
                height={chartH + 24}
                viewBox={`0 0 ${chartW} ${chartH + 24}`}
                role="img"
                aria-label="盲测成绩柱状图"
                data-testid="blind-chart"
              >
                {[0, 50, 100].map((v) => (
                  <g key={v}>
                    <line
                      x1="0"
                      y1={chartH - (v / maxScore) * chartH}
                      x2={chartW}
                      y2={chartH - (v / maxScore) * chartH}
                      stroke="#e6e8f5"
                      strokeWidth="1"
                    />
                    <text x="0" y={chartH - (v / maxScore) * chartH - 3} fontSize="9" fill="#9aa0bb">
                      {v}
                    </text>
                  </g>
                ))}
                {series.map((s, i) => {
                  const h = ((s.avg_pron ?? 0) / maxScore) * chartH;
                  const x = 14 + i * (barW + gap);
                  return (
                    <g key={s.blind_test_id}>
                      <rect
                        x={x}
                        y={chartH - h}
                        width={barW}
                        height={Math.max(2, h)}
                        rx="6"
                        fill={i === series.length - 1 ? "#5b5bd6" : "#c7c9f2"}
                      />
                      <text x={x + barW / 2} y={chartH - h - 4} fontSize="11" textAnchor="middle" fill="#1b1f3b">
                        {s.avg_pron}
                      </text>
                      <text x={x + barW / 2} y={chartH + 14} fontSize="9" textAnchor="middle" fill="#9aa0bb">
                        {s.ended_at ? new Date(s.ended_at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : ""}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="ec-card">
          <p className="text-sm">
            还没有完成过盲测。先做一次，下周再做一次，就能看到“到底有没有变好”了。
          </p>
          <div className="mt-3 flex gap-2">
            <Link href="/practice" className="ec-btn ec-btn-ghost">
              先去跟读练习
            </Link>
            <Link href="/blindtest" className="ec-btn ec-btn-primary">
              开始盲测
            </Link>
          </div>
        </section>
      )}

      {data.tests.length > 0 ? (
        <section className="ec-card">
          <h2 className="font-bold">历史记录</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-[var(--ec-muted)]">
              <tr>
                <th className="py-1">结束时间</th>
                <th>句数</th>
                <th>综合分</th>
                <th>准确度</th>
                <th>流利度</th>
                <th>语调差异</th>
              </tr>
            </thead>
            <tbody>
              {data.tests.map((t) => (
                <tr key={t.id} className="border-t border-[#eef0f8]">
                  <td className="py-1">
                    {t.ended_at ? new Date(t.ended_at).toLocaleString("zh-CN") : "进行中"}
                  </td>
                  <td>{t.item_count}</td>
                  <td>{t.avg_pron ?? "—"}</td>
                  <td>{t.avg_accuracy ?? "—"}</td>
                  <td>{t.avg_fluency ?? "—"}</td>
                  <td>{t.avg_intonation_distance ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
