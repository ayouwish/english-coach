import Link from "next/link";
import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { adminEnabled, hasAdminSession } from "@/lib/admin-auth";
import { buildAdminCosts } from "@/lib/admin-costs";
import { AdminLogoutButton } from "./AdminLogoutButton";
import { AdminFamilyInvites } from "./AdminFamilyInvites";

export const dynamic = "force-dynamic";

/** /admin —— 独立管理员后台（task-110）：成本看板，不套家庭导航。 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await ensureBootstrap();
  if (!adminEnabled()) {
    return (
      <div className="ec-card" data-testid="admin-disabled-page">
        <h1 className="text-xl font-extrabold">🔐 管理员后台</h1>
        <p className="mt-2 text-sm">后台未启用：请在服务端设置环境变量 <code>ADMIN_PASSWORD</code> 后重启。</p>
      </div>
    );
  }
  if (!(await hasAdminSession())) redirect("/admin/login");
  const sp = await searchParams;
  const data = await buildAdminCosts(sp.month ?? null);
  const yuan = (n: number) => `¥${n.toFixed(2)}`;
  const [y, mo] = data.month.split("-").map(Number);
  // 注意：JS 月份 0-based；mo 是 1-based 当前月 → 上个月索引 = mo - 2
  const prev = new Date(Date.UTC(mo === 1 ? y - 1 : y, mo === 1 ? 11 : mo - 2, 1));
  const nextD = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 7);

  return (
    <div className="flex flex-col gap-5" data-testid="admin-page">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-extrabold">📊 管理员后台 · 成本看板</h1>
          <AdminLogoutButton />
        </div>
        <p className="mt-1 text-xs text-[var(--ec-muted)]">
          独立后台（不使用家庭账号）· 跨家庭成本与用量 · 金额按 cost_events 微元金额汇总 · 单价可在 web 环境变量配置。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="admin-month">
          <Link href={`/admin?month=${fmt(prev)}`} className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs">← 上个月</Link>
          <span className="text-sm font-semibold">{data.month}</span>
          <Link href={`/admin?month=${fmt(nextD)}`} className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs">下个月 →</Link>
        </div>
      </section>

      <section className="ec-card" data-testid="admin-totals">
        <h2 className="text-base font-extrabold">本月总计</h2>
        <p className="mt-1 text-3xl font-extrabold" data-testid="admin-total">{yuan(data.totals.cost_cny)}</p>
        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-xl bg-[var(--ec-primary-soft)] p-2">
            LLM tokens：<strong data-testid="admin-tokens">{data.totals.llm_total_tokens}</strong>
            <span className="block text-xs text-[var(--ec-muted)]">输入 {data.totals.llm_prompt_tokens} / 输出 {data.totals.llm_completion_tokens}</span>
          </div>
          <div className="rounded-xl bg-[#e8f7ee] p-2">图片：<strong data-testid="admin-images">{data.totals.image_count}</strong> 张</div>
          <div className="rounded-xl bg-[#eef4ff] p-2">TTS <strong>{data.totals.tts_chars}</strong> 字符 / ASR <strong>{data.totals.asr_seconds}</strong> 秒</div>
          <div className="rounded-xl bg-[#fff3d6] p-2">调用：<strong data-testid="admin-calls">{data.totals.calls}</strong> 次</div>
        </div>
      </section>

      <AdminFamilyInvites />

      <section className="ec-card">
        <h2 className="text-base font-extrabold">按家庭</h2>
        {data.by_family.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ec-muted)]">本月还没有成本记录。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="admin-families">
              <thead><tr className="text-xs text-[var(--ec-muted)]"><th className="py-1">家庭</th><th>成员</th><th>成本</th><th>LLM tokens</th><th>图片</th><th>TTS</th><th>ASR</th><th>调用</th></tr></thead>
              <tbody>
                {data.by_family.map((f) => (
                  <tr key={f.family_id} data-testid="admin-family-row" className="border-t border-[#eef0f8]">
                    <td className="py-1 font-semibold">{f.family_name}</td><td>{f.members}</td>
                    <td className="tabular-nums">{yuan(f.cost_cny)}</td><td className="tabular-nums">{f.llm_total_tokens}</td>
                    <td>{f.image_count}</td><td>{f.tts_chars}</td><td>{f.asr_seconds}</td><td>{f.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ec-card">
        <h2 className="text-base font-extrabold">按天</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="admin-days">
          {data.by_day.map((d) => (<li key={d.date} className="flex justify-between"><span>{d.date}</span><span className="tabular-nums">{yuan(d.cost_cny)}</span></li>))}
          {data.by_day.length === 0 ? <li className="text-[var(--ec-muted)]">—</li> : null}
        </ul>
      </section>

      <section className="ec-card">
        <h2 className="text-base font-extrabold">最近事件（最多 50）</h2>
        <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="admin-recent">
          {data.recent_events.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 border-t border-[#eef0f8] py-1">
              <span>{new Date(e.created_at).toLocaleString("zh-CN")} · {e.family_name} · {e.display_name ?? "—"} · {e.kind}{e.model ? ` · ${e.model}` : ""}</span>
              <span className="tabular-nums">{yuan(e.cost_cny)}</span>
            </li>
          ))}
          {data.recent_events.length === 0 ? <li className="text-[var(--ec-muted)]">—</li> : null}
        </ul>
      </section>
    </div>
  );
}
