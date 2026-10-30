import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { attempts, storyRetells } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import { IllustrateBox } from "@/components/IllustrateBox";
import { RetellPanel } from "@/components/RetellPanel";
import { splitSentences } from "@/lib/sentence-split";

export const dynamic = "force-dynamic";

/**
 * /story/[id] —— 故事详情（task-50 P1/P3）：
 * 英文全文 + 你的录音回放 + 历次朗读趋势（**仅家长视角显示分数**）+ 复述记录 + 「讲给我听」。
 * 儿童视角：不显示任何分数，只显示"读过几次 / 讲了几次"。
 */
export default async function StoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const material = await getMaterial(id);
  if (!material || material.kind !== "story") {
    return (
      <div className="flex flex-col gap-5">
        <section className="ec-card">
          <h1 className="text-xl font-extrabold">找不到这个故事</h1>
          <p className="mt-2 text-sm text-[var(--ec-muted)]">它可能已经被删除了。</p>
          <Link href="/story" className="ec-btn ec-btn-primary mt-3">
            返回故事集
          </Link>
        </section>
      </div>
    );
  }

  const db = getDb();
  // 谁读的：孩子 = 自己；家长看孩子的故事 = 故事创建者（分数只给家长看）
  const ownerId = user.isChild ? user.id : (material.createdBy ?? user.id);
  const reads = await db
    .select({ id: attempts.id, scoresJson: attempts.scoresJson, audioPath: attempts.audioPath, createdAt: attempts.createdAt })
    .from(attempts)
    .where(and(eq(attempts.userId, ownerId), eq(attempts.materialId, id), eq(attempts.status, "done")))
    .orderBy(desc(attempts.createdAt))
    .limit(20);
  const lastWithAudio = reads.find((r) => r.audioPath) ?? null;
  const retells = await db
    .select()
    .from(storyRetells)
    .where(and(eq(storyRetells.userId, ownerId), eq(storyRetells.materialId, id)))
    .orderBy(desc(storyRetells.createdAt))
    .limit(10);
  const sentences = splitSentences(material.text);

  const scores = reads
    .map((r) => {
      try {
        const parsed = JSON.parse(r.scoresJson ?? "{}") as { pron?: number | null };
        return typeof parsed.pron === "number" ? parsed.pron : null;
      } catch {
        return null;
      }
    })
    .filter((s): s is number => typeof s === "number");
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-extrabold">{material.title}</h1>
          <span className="text-xs text-[var(--ec-muted)]">
            {material.level ? `${material.level} · ` : ""}
            {new Date(material.createdAt).toLocaleDateString("zh-CN")}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/flow?material=${encodeURIComponent(material.id)}`} className="ec-btn ec-btn-primary" data-testid="detail-read">
            ▶ 读这篇
          </Link>
          <Link href="/story" className="ec-btn ec-btn-ghost">
            返回故事集
          </Link>
        </div>
      </section>

      <section className="ec-card" data-testid="detail-text">
        <h2 className="text-base font-extrabold">英文全文</h2>
        <ol className="mt-2 list-decimal pl-5 text-sm leading-relaxed">
          {sentences.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {material.sourceZh ? (
          <details className="mt-3 text-xs text-[var(--ec-muted)]">
            <summary className="cursor-pointer">看看你当时怎么讲的（中文）</summary>
            <p className="mt-1 whitespace-pre-wrap">{material.sourceZh}</p>
          </details>
        ) : null}
      </section>

      <section className="ec-card" data-testid="detail-illustration">
        <h2 className="text-base font-extrabold">🖼️ 故事插画</h2>
        <p className="mt-1 text-xs text-[var(--ec-muted)]">
          每天给这个故事画一张画（水彩风格）。画的时候可以先去读，不影响练习。
        </p>
        <IllustrateBox materialId={material.id} hasImage={Boolean(material.imagePath)} isChild={user.isChild} />
      </section>

      <section className="ec-card" data-testid="detail-audio">
        <h2 className="text-base font-extrabold">听我上次读的</h2>
        {lastWithAudio ? (
          <div className="mt-2 flex flex-col gap-1">
            {/* 录音来自 attempts.audio_path（不进库，走 /api/audio/:attemptId 流式返回） */}
            <audio controls preload="none" src={`/api/audio/${lastWithAudio.id}`} data-testid="detail-audio-player" className="w-full max-w-md" />
            <span className="text-xs text-[var(--ec-muted)]">
              最近一次朗读 · {new Date(lastWithAudio.createdAt).toLocaleString("zh-CN")}
            </span>
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--ec-muted)]" data-testid="detail-no-audio">
            还没有录音。点「读这篇」读一遍，这里就能听到你自己的声音。
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--ec-muted)]">
          {user.isChild ? `你已经读过这个故事 ${reads.length} 次。` : `朗读记录 ${reads.length} 次${avg !== null ? `，平均 ${avg} 分` : ""}（仅家长可见分数）`}
        </p>
        {!user.isChild && scores.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1" data-testid="detail-scores">
            {scores.slice(0, 10).map((s, i) => (
              <span key={i} className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">
                {s}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="ec-card" data-testid="detail-retells">
        <h2 className="text-base font-extrabold">复述记录</h2>
        {retells.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--ec-muted)]">还没有复述记录。读完后点「🎤 讲给我听」试试。</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {retells.map((r) => (
              <li key={r.id} className="rounded-xl bg-[#f8f9ff] p-2 text-sm" data-testid="detail-retell-item">
                <span className="text-xs text-[var(--ec-muted)]">
                  {new Date(r.createdAt).toLocaleString("zh-CN")}
                  {typeof r.coverage === "number" ? ` · 覆盖度 ${Math.round(r.coverage * 100)}%` : ""}
                </span>
                <p className="mt-1">{r.feedbackZh || "复述完成"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ec-card">
        <h2 className="text-base font-extrabold">🎤 讲给我听</h2>
        <p className="mt-1 text-xs text-[var(--ec-muted)]">不看屏幕，用 2–3 句话把故事讲一遍（不计发音分）。</p>
        <RetellPanel materialId={material.id} storySentences={sentences} level={material.level ?? "A2"} isChild={user.isChild} />
      </section>
    </div>
  );
}
