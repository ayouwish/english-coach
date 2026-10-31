import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions, users } from "@/db/schema";
import { ChatSessionAudio } from "@/components/ChatSessionAudio";
import { PronunciationNote } from "@/components/PronunciationNote";
import { parsePron } from "@/lib/chat-pronunciation";
import { parseSessionSummary } from "@/lib/chat-summary";
import { ttsUrl } from "@/lib/tts-url";
import { getCurrentUser } from "@/lib/auth";
import { getPrefs } from "@/lib/prefs";
import { effectiveTtsRate } from "@/lib/tts-rate";
import type { DialogueCorrection } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseCorrection(raw: string | null): DialogueCorrection | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DialogueCorrection;
    return v && v.has_error ? v : null;
  } catch {
    return null;
  }
}

/**
 * 会话详情页（task-74 ④）：完整消息 + 校正提示 + 发音信息 + 用户录音 + 整段回放 + 本次评价。
 * 只有本人能看（服务端校验，不是前端隐藏）。
 */
export default async function ChatSessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const db = getDb();
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) notFound();

  const [scenario] = await db.select().from(chatScenarios).where(eq(chatScenarios.id, session.scenarioId)).limit(1);
  // 场景可能已下线/被替换：回退显示原始 id，不崩
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatSessionId, id))
    .orderBy(asc(chatMessages.createdAt));
  const summary = parseSessionSummary(session.summaryJson);
  const prefs = await getPrefs(user.id, user.isChild);
  const speechRate = effectiveTtsRate(user, prefs);
  const [owner] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id)).limit(1);

  return (
    <div className="flex flex-col gap-4" data-testid="chat-session-detail">
      <section className="ec-card">
        <Link href="/chat" className="text-xs underline">
          ← 返回对话训练
        </Link>
        <h1 className="mt-1 text-lg font-extrabold">
          {scenario?.titleZh ?? session.scenarioId}
          <span className="ml-2 text-sm font-normal text-[var(--ec-muted)]">{scenario?.title ?? ""}</span>
        </h1>
        <p className="text-xs text-[var(--ec-muted)]">
          {new Date(session.startedAt).toLocaleString("zh-CN")} · {session.turnCount} 轮
          {session.endedAt ? ` · 已结束` : " · 还在进行"}
        </p>

        {/* 本次评价（task-74 ③）：家长看分数，儿童只看鼓励语 */}
        {summary ? (
          <div className="mt-2 rounded-xl bg-[#f8f9ff] p-3 text-sm" data-testid="session-summary">
            {user.isChild ? (
              <p>这次聊得不错，下次我们继续加油 🙂</p>
            ) : (
              <>
                <p>
                  本次平均发音 <strong>{summary.avg_pron ?? "—"}</strong>
                  {typeof summary.avg_accuracy === "number" ? ` · 准确 ${summary.avg_accuracy}` : ""}
                  {typeof summary.avg_fluency === "number" ? ` · 流利 ${summary.avg_fluency}` : ""}
                  {typeof summary.avg_completeness === "number" ? ` · 完整 ${summary.avg_completeness}` : ""}
                </p>
                {summary.weak_phonemes?.length ? (
                  <p className="mt-1 text-xs text-[var(--ec-muted)]">
                    最需要练：{summary.weak_phonemes.map((w) => w.label).join(" / ")}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-[var(--ec-muted)]">有评分的轮次：{summary.scored_turns} 轮</p>
              </>
            )}
          </div>
        ) : null}

        {messages.length > 0 ? <ChatSessionAudio sessionId={session.id} isChild={user.isChild} /> : null}
      </section>

      <section className="ec-card">
        <h2 className="font-bold">完整对话（{messages.length} 条）</h2>
        <div className="mt-3 flex flex-col gap-2">
          {messages.map((m) => {
            const correction = parseCorrection(m.correctionJson);
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  m.role === "user" ? "self-end bg-[var(--ec-primary)] text-white" : "self-start bg-[#f8f9ff]"
                }`}
              >
                <p className="font-medium">{m.text}</p>
                {m.textZh ? <p className="mt-0.5 text-xs opacity-80">{m.textZh}</p> : null}
                {/* task-74 ②：历史里也保留「更自然：…」校正提示 */}
                {correction ? (
                  <div className="mt-2 rounded-lg bg-[#fff3d6] p-2 text-xs text-[#7a4d00]" data-testid="history-correction">
                    <p>
                      更自然：<strong>{correction.better}</strong>
                    </p>
                    {correction.explain_zh ? <p>{correction.explain_zh}</p> : null}
                  </div>
                ) : null}
                {m.flag === "unsafe_filtered" ? (
                  <p className="mt-1 text-xs">（内容已按儿童安全规则替换）</p>
                ) : null}
                {m.role === "user" && m.pronJson ? (
                  <div className={m.role === "user" ? "text-white" : ""}>
                    <PronunciationNote pron={parsePron(m.pronJson)} isChild={user.isChild} testid="history-pron" />
                  </div>
                ) : null}
                {m.role === "user" && m.audioPath ? (
                  <audio
                    controls
                    preload="metadata"
                    src={`/api/audio/${m.id}`}
                    data-testid="user-audio"
                    aria-label={`播放我说的这句话：${m.text}`}
                    className="mt-2 h-9 w-full max-w-[280px]"
                  />
                ) : null}
                {m.role === "assistant" ? (
                  <audio
                    controls
                    preload="metadata"
                    src={ttsUrl(m.text, speechRate, "mp3")}
                    data-testid="tts-audio"
                    aria-label={`朗读这句话：${m.text}`}
                    className="mt-2 h-9 w-full max-w-[280px]"
                  />
                ) : null}
              </div>
            );
          })}
          {messages.length === 0 ? <p className="text-sm text-[var(--ec-muted)]">这个会话还没有消息。</p> : null}
        </div>
        <p className="mt-3 text-xs text-[var(--ec-muted)]">
          {owner?.displayName ? `练习人：${owner.displayName} · ` : ""}
          历史记录按时间顺序保存，家长可回看每次对话的校正与评价。
        </p>
      </section>
    </div>
  );
}
