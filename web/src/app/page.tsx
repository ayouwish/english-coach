import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCapabilities } from "@/lib/voice";
import { getDailyUsage } from "@/lib/usage";
import { ensureBootstrap } from "@/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  const { reachable, mode, capabilities } = await getCapabilities();
  const isChild = user.isChild;

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-2xl font-extrabold">
          {isChild ? `${user.avatar ?? "🧒"} 你好，${user.displayName}！` : `欢迎回来，${user.displayName}`}
        </h1>
        <p className="mt-2 text-sm text-[var(--ec-muted)]">
          今天已练习 <strong>{usage.minutes}</strong> / {usage.limitMinutes} 分钟 · 跟读{" "}
          {usage.attemptCount} 次 · 对话 {usage.chatTurnCount} 轮
          {isChild ? ` · 还剩 ${usage.remainingMinutes} 分钟` : ""}
        </p>
        {isChild && usage.exceeded ? (
          <p className="ec-pop mt-3 rounded-xl bg-[#fff3d6] p-3 text-sm">
            🌙 今天的练习时间到啦，今天就到这里，我们明天继续！
          </p>
        ) : null}
        <p className="mt-3 text-xs text-[var(--ec-muted)]">
          语音服务：{reachable ? `已就绪（mode=${mode}）` : "暂未就绪 —— 录音与文本仍会保存，稍后可重试"}{" "}
          · 音素级：{capabilities.phoneme_level ? "支持" : "不支持（显示单词级粗评）"} · 语调曲线：
          {capabilities.intonation_curve ? "支持" : "不支持"}
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link href="/practice" className="ec-card block hover:shadow-lg">
          <div className="text-3xl">🎤</div>
          <h2 className="mt-2 text-lg font-bold">跟读练习</h2>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            录一句，听示范音，看音素热力图和音调对比曲线。
          </p>
        </Link>
        <Link href="/chat" className="ec-card block hover:shadow-lg">
          <div className="text-3xl">💬</div>
          <h2 className="mt-2 text-lg font-bold">对话训练</h2>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            点餐、自我介绍、学校、动物……按年龄分级，逐轮推进。
          </p>
        </Link>
        <Link href="/review" className="ec-card block hover:shadow-lg">
          <div className="text-3xl">📒</div>
          <h2 className="mt-2 text-lg font-bold">错音本 / 复习</h2>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            弱音素自动进卡片，按 SM-2 排期复习（再来一次 / 有点难 / 记住了 / 太简单）。
          </p>
        </Link>
        {user.role === "parent" ? (
          <Link href="/parent" className="ec-card block hover:shadow-lg">
            <div className="text-3xl">👨‍👩‍👧</div>
            <h2 className="mt-2 text-lg font-bold">家长面板</h2>
            <p className="mt-1 text-sm text-[var(--ec-muted)]">
              学习时长、平均分趋势、高频错音 TOP10、女儿今日剩余时长。
            </p>
          </Link>
        ) : (
          <div className="ec-card">
            <div className="text-3xl">⭐</div>
            <h2 className="mt-2 text-lg font-bold">今天的小目标</h2>
            <p className="mt-1 text-sm text-[var(--ec-muted)]">
              读满 10 句就能得到一颗小星星，加油！
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
