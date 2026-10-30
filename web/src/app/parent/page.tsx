import { forbidden, redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { FamilyMembersPanel } from "@/components/FamilyMembersPanel";
import { buildParentSummary, type MemberSummary } from "@/lib/parent-summary";
import { getCapabilities } from "@/lib/voice";

export const dynamic = "force-dynamic";

/**
 * /parent —— 仅 parent 角色。
 * child 访问由服务端 `forbidden()` 拦截，返回 HTTP 403（不是只隐藏菜单）。
 * 数据面同样双保险：/api/parent/summary 用 requireParent() 再校验一次。
 */
export default async function ParentPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "parent") forbidden();

  const summary = await buildParentSummary();
  const caps = await getCapabilities();

  return (
    <div className="flex flex-col gap-5" data-testid="parent-dashboard">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">👨‍👩‍👧 家长面板</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          全家今天共练习 <strong>{summary.family.minutes_today}</strong> 分钟，近 7 天{" "}
          {summary.family.minutes_7d} 分钟 · 语料 {summary.family.sentence_count} 句 · 对话场景{" "}
          {summary.family.scenario_count} 个
        </p>
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          语音服务：{caps.reachable ? `已就绪（mode=${caps.mode}，音素级=${
            caps.capabilities.phoneme_level ? "支持" : "不支持"
          }，语调曲线=${caps.capabilities.intonation_curve ? "支持" : "不支持"}）` : "未就绪"}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {summary.family.children.map((c) => (
            <div key={c.id} className="rounded-xl bg-[var(--ec-primary-soft)] p-3">
              <p className="text-sm font-semibold">{c.display_name} 今日剩余时长</p>
              <p className="text-2xl font-extrabold" data-testid="child-remaining">
                {c.remaining_minutes} <span className="text-sm font-medium">/ {c.limit_minutes} 分钟</span>
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* task-54：家庭成员管理（创建账号 / 不同英语水平 / 重置密码） */}
      <FamilyMembersPanel viewerId={user.id} />

      <BlindWeeklyPanel members={summary.members.filter((m) => m.role === "child")} />

      {summary.members.map((m) => (
        <MemberCard key={m.id} member={m} />
      ))}
    </div>
  );
}

/**
 * 盲测周环比 —— 家长判断“到底有没有变好”的唯一依据，因此放在面板最显眼的位置
 * （大字号分值 + 本周 vs 上周差值 + 历次柱状图）。
 */
function BlindWeeklyPanel({ members }: { members: MemberSummary[] }) {
  return (
    <section
      className="ec-card border-2 border-[var(--ec-primary)]"
      data-testid="blind-weekly-panel"
    >
      <h2 className="text-lg font-extrabold">🎯 盲测周环比 · 判断「到底有没有变好」</h2>
      <p className="mt-1 text-xs text-[var(--ec-muted)]">
        同一组句子、全程不给反馈。日常练习的分数会因为“看完反馈立刻重读”而虚高，只有盲测能证明真的进步了。
      </p>

      {members.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ec-muted)]">还没有儿童账号。</p>
      ) : (
        members.map((m) => {
          const b = m.blind;
          const delta = b.delta_pron;
          const series = b.series.filter((s) => s.avg_pron !== null);
          const maxScore = Math.max(100, ...series.map((s) => s.avg_pron ?? 0));
          const barW = 40;
          const gap = 14;
          const chartH = 110;
          const chartW = Math.max(240, series.length * (barW + gap) + 20);
          return (
            <div key={m.id} className="mt-4 rounded-2xl bg-[var(--ec-primary-soft)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-base font-bold">
                  {m.avatar ?? "🙂"} {m.display_name}
                  {b.in_progress_id ? (
                    <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-[var(--ec-primary)]">
                      正在做盲测…
                    </span>
                  ) : null}
                </p>
                <span className="text-xs text-[var(--ec-muted)]">
                  已完成盲测 {b.weeks} 次
                  {b.current?.ended_at
                    ? ` · 最近一次 ${new Date(b.current.ended_at).toLocaleDateString("zh-CN")}`
                    : ""}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-8">
                <div>
                  <p className="text-xs text-[var(--ec-muted)]">最近一次盲测综合分</p>
                  <p className="text-5xl font-extrabold leading-none" data-testid="blind-current-pron">
                    {b.current?.avg_pron ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--ec-muted)]">本周 vs 上周</p>
                  <p
                    className="text-3xl font-extrabold"
                    data-testid="blind-delta-pron"
                    style={{
                      color:
                        delta === null ? "#6b7290" : delta > 0 ? "#16a34a" : delta < 0 ? "#ef4444" : "#6b7290",
                    }}
                  >
                    {delta === null
                      ? b.current
                        ? "首次（无对比）"
                        : "还没有盲测数据"
                      : `${delta > 0 ? "▲ +" : delta < 0 ? "▼ " : "＝ "}${delta} 分`}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ec-muted)]">
                    {b.previous?.avg_pron !== null && b.previous !== null
                      ? `上次 ${b.previous.avg_pron} 分 → 这次 ${b.current?.avg_pron ?? "—"} 分`
                      : "做完第二次盲测就能看到环比"}
                  </p>
                </div>
                <div className="text-xs text-[var(--ec-muted)]">
                  <p>准确度 {b.current?.avg_accuracy ?? "—"}</p>
                  <p>流利度 {b.current?.avg_fluency ?? "—"}</p>
                  <p>语调差异 {b.current?.avg_intonation_distance ?? "—"}</p>
                </div>
              </div>

              {series.length > 0 ? (
                <div className="mt-3 overflow-x-auto">
                  <svg
                    width={chartW}
                    height={chartH + 20}
                    viewBox={`0 0 ${chartW} ${chartH + 20}`}
                    role="img"
                    aria-label="盲测周环比柱状图"
                    data-testid="blind-weekly-chart"
                  >
                    {[0, 50, 100].map((v) => (
                      <line
                        key={v}
                        x1="0"
                        y1={chartH - (v / maxScore) * chartH}
                        x2={chartW}
                        y2={chartH - (v / maxScore) * chartH}
                        stroke="#ffffff"
                        strokeWidth="1"
                      />
                    ))}
                    {series.map((s, i) => {
                      const h = ((s.avg_pron ?? 0) / maxScore) * chartH;
                      const x = 10 + i * (barW + gap);
                      return (
                        <g key={s.blind_test_id}>
                          <rect
                            x={x}
                            y={chartH - h}
                            width={barW}
                            height={Math.max(2, h)}
                            rx="5"
                            fill={i === series.length - 1 ? "#5b5bd6" : "#a9abec"}
                          />
                          <text
                            x={x + barW / 2}
                            y={chartH - h - 3}
                            fontSize="11"
                            textAnchor="middle"
                            fill="#1b1f3b"
                          >
                            {s.avg_pron}
                          </text>
                          <text
                            x={x + barW / 2}
                            y={chartH + 12}
                            fontSize="9"
                            textAnchor="middle"
                            fill="#6b7290"
                          >
                            {s.ended_at
                              ? new Date(s.ended_at).toLocaleDateString("zh-CN", {
                                  month: "numeric",
                                  day: "numeric",
                                })
                              : ""}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              ) : (
                <p className="mt-3 text-sm text-[var(--ec-muted)]">
                  还没有完成的盲测。让孩子去「🎯 盲测周报」做一次（同一组句子、无反馈），下周再做一次就能看到环比。
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <a href={`/blindtest/report`} className="ec-btn ec-btn-ghost">
                  查看周报详情
                </a>
                <span className="self-center text-xs text-[var(--ec-muted)]">
                  周报接口：<code>GET /api/blind-tests?user_id={m.id}</code>
                </span>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

function MemberCard({ member }: { member: MemberSummary }) {
  const maxTrend = Math.max(100, ...member.trend.map((t) => t.avg_pron ?? 0));
  const points = member.trend
    .map((t, i) => {
      const x = member.trend.length <= 1 ? 0 : (i * 260) / (member.trend.length - 1);
      const y = 60 - ((t.avg_pron ?? 0) / maxTrend) * 55;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <section className="ec-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          {member.avatar ?? "🙂"} {member.display_name}
          <span className="ml-2 rounded-full bg-[var(--ec-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--ec-primary)]">
            {member.role === "parent" ? "家长" : "儿童"} · {member.cefr_level}
          </span>
        </h2>
        <p className="text-sm text-[var(--ec-muted)]">
          今日练习 {member.today.minutes} 分钟
          {member.today.blind_minutes > 0 ? ` + 盲测 ${member.today.blind_minutes} 分钟` : ""} · 跟读{" "}
          {member.today.attempt_count} 次 · 对话 {member.today.chat_turns} 轮
          {member.today.remaining_minutes !== null ? ` · 剩余 ${member.today.remaining_minutes} 分钟` : ""}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Stat label="近 7 天时长" value={`${member.week.minutes} 分钟`} />
        <Stat label="近 7 天练习" value={`${member.week.attempts} 次`} />
        <Stat
          label="近 7 天平均分"
          value={member.week.avg_pron === null ? "—" : String(member.week.avg_pron)}
        />
        <Stat
          label="累计"
          value={`${member.totals.attempts} 次跟读 / ${member.totals.chat_sessions} 场对话`}
        />
      </div>

      {member.trend.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-bold text-[var(--ec-muted)]">平均分趋势（近 14 天）</h3>
          <svg width="100%" height="70" viewBox="0 0 270 70" preserveAspectRatio="none" aria-label="平均分趋势">
            <polyline points={points} fill="none" stroke="#5b5bd6" strokeWidth="2.5" />
            <line x1="0" y1="60" x2="270" y2="60" stroke="#e6e8f5" strokeWidth="1" />
          </svg>
          <p className="text-xs text-[var(--ec-muted)]">
            {member.trend
              .slice(-3)
              .map((t) => `${t.date}: ${t.avg_pron ?? "—"}`)
              .join(" · ")}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-bold text-[var(--ec-muted)]">高频错音 TOP10</h3>
          {member.top_phonemes.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--ec-muted)]">暂无数据</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {member.top_phonemes.map((p) => (
                <li key={p.phoneme} className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {p.phoneme} <span className="font-normal text-[var(--ec-muted)]">{p.title_zh}</span>
                  </span>
                  <span className="text-[var(--ec-muted)]">
                    均 {p.avg_score} · {p.count} 次 · 低于60 {p.hard_hits} 次
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-sm font-bold text-[var(--ec-muted)]">
            高频错词（单词级粗评）
          </h3>
          {member.top_words.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--ec-muted)]">
              暂无（当前 provider 支持音素级，或还没有评测）
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">
              {member.top_words.map((w) => (
                <li key={w.word} className="rounded-lg bg-[#fff3d6] px-3 py-1">
                  <strong>{w.word}</strong> × {w.count}（均 {w.avg_score}）
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#f8f9ff] p-3">
      <p className="text-xs text-[var(--ec-muted)]">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
