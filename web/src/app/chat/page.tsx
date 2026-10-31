import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions } from "@/db/schema";
import { ChatSessionAudio } from "@/components/ChatSessionAudio";
import { PronunciationNote } from "@/components/PronunciationNote";
import { parsePron } from "@/lib/chat-pronunciation";
import { parseSessionSummary } from "@/lib/chat-summary";
import { readChatAudioMeta } from "@/lib/chat-audio";
import { ttsUrl } from "@/lib/tts-url";
import { getCurrentUser } from "@/lib/auth";
import { audienceForUser, scenarioAudience } from "@/lib/chat";
import { getCapabilities } from "@/lib/voice";
import { getPrefs } from "@/lib/prefs";
import { effectiveTtsRate } from "@/lib/tts-rate";
import { getDailyUsage } from "@/lib/usage";
import { ChatClient } from "./ChatClient";

export const dynamic = "force-dynamic";

function ageOfUser(birthYear: number | null, ageBand: string): number {
  if (!birthYear) return ageBand === "child" ? 7 : 30;
  return Math.max(3, new Date().getFullYear() - birthYear);
}

export default async function ChatPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const rows = await getDb()
    .select()
    .from(chatScenarios)
    .where(eq(chatScenarios.enabled, 1))
    .orderBy(asc(chatScenarios.sortOrder));

  const age = ageOfUser(user.birthYear, user.ageBand);
  // task-68：按 audience 过滤（儿童只看儿童场景；成人只看成人场景）
  const wanted = audienceForUser(user);
  const visible = rows.filter((r) => {
    const tags = JSON.parse(r.tags) as string[];
    return scenarioAudience(tags) === wanted && (!user.isChild || r.minAge <= age);
  });
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  const caps = await getCapabilities();

  // 最近一次对话（只读回放）：让用户回来看得到上次聊了什么，也方便逐句重播。
  // 服务端渲染 → 重播按钮的 aria-label 直接出现在 HTML 里（无浏览器环境也能断言）。
  const [lastSession] = await getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.userId, user.id))
    .orderBy(desc(chatSessions.startedAt))
    .limit(1);
  // task-74 ④：历史对话列表（最近 30 次，倒序）——不再只保留最后一次
  const historySessions = await getDb()
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.userId, user.id))
    .orderBy(desc(chatSessions.startedAt))
    .limit(30);
  const scenarioTitleById = new Map(rows.map((r) => [r.id, r.titleZh]));
  const lastMessages = lastSession
    ? await getDb()
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatSessionId, lastSession.id))
        .orderBy(asc(chatMessages.createdAt))
        .limit(20)
    : [];
  const lastScenario = lastSession
    ? (
        await getDb()
          .select()
          .from(chatScenarios)
          .where(eq(chatScenarios.id, lastSession.scenarioId))
          .limit(1)
      )[0]
    : null;
  // 语速：尊重偏好（儿童默认 slow，可被设置覆盖）—— task-21
  const speechRate = effectiveTtsRate(user, await getPrefs(user.id, user.isChild));

  return (
    <div className="flex flex-col gap-5">
    <ChatClient
      isChild={user.isChild}
      age={age}
      scenarios={visible.map((r) => ({
        id: r.id,
        title: r.title,
        title_zh: r.titleZh,
        setting_zh: r.settingZh,
        opening_line: r.openingLine,
        level: r.level,
        min_age: r.minAge,
        tags: JSON.parse(r.tags) as string[],
      }))}
      hiddenCount={rows.length - visible.length}
      usage={usage}
      ttsRate={speechRate}
      voiceReachable={caps.reachable}
    />

      {lastMessages.length > 0 ? (
        <details className="ec-card" data-testid="last-chat">
          <summary className="cursor-pointer font-bold">
            最近一次对话（{lastScenario?.titleZh ?? lastSession?.scenarioId}）· {lastMessages.length} 条记录
            <span className="ml-2 font-normal text-[var(--ec-muted)]">点助手消息旁的「🔊 重播」可再听一遍</span>
          </summary>
          {lastSession ? <ChatSessionAudio sessionId={lastSession.id} isChild={user.isChild} /> : null}
          <div className="mt-3 flex flex-col gap-2">
            {lastMessages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "self-end bg-[var(--ec-primary)] text-white"
                    : "self-start bg-[#f8f9ff]"
                }`}
              >
                <p className="font-medium">{m.text}</p>
                {m.textZh ? <p className="mt-0.5 text-xs opacity-80">{m.textZh}</p> : null}
                {/* 语音轮次的发音信息（task-57）：家长看分数，儿童只看鼓励 */}
                {m.role === "user" && ((m.pronJson ?? null) !== null || Boolean(m.audioPath)) ? (
                  <PronunciationNote pron={parsePron(m.pronJson ?? null)} isChild={user.isChild} testid="history-pron" />
                ) : null}
                {/* 用户自己的录音回放（task-70）：有录音才渲染，旧消息没录音不显示坏播放器 */}
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
            ))}
          </div>
        </details>
      ) : null}

      {/* task-74 ④：历史对话列表（可点进详情页看完整消息 + 校正 + 评价 + 整段回放） */}
      {historySessions.length > 0 ? (
        <section className="ec-card" data-testid="chat-history-list">
          <h2 className="font-bold">📚 历史对话（{historySessions.length} 次）</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {historySessions.map((sess) => {
              const summary = parseSessionSummary(sess.summaryJson);
              const audioReady = readChatAudioMeta(sess.id)?.status === "ready";
              return (
                <li key={sess.id}>
                  <Link
                    href={`/chat/sessions/${sess.id}`}
                    data-testid="chat-history-item"
                    className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--ec-primary-soft)]"
                  >
                    <span className="text-xs text-[var(--ec-muted)]">{new Date(sess.startedAt).toLocaleString("zh-CN")}</span>
                    <span className="font-medium">{scenarioTitleById.get(sess.scenarioId) ?? sess.scenarioId}</span>
                    <span className="text-xs text-[var(--ec-muted)]">{sess.turnCount} 轮</span>
                    {user.isChild ? (
                      <span className="text-xs text-[var(--ec-muted)]">聊完了</span>
                    ) : summary?.avg_pron !== null && summary?.avg_pron !== undefined ? (
                      <span className="rounded-full bg-[#eef0f8] px-2 py-0.5 text-xs">平均发音 {summary.avg_pron}</span>
                    ) : null}
                    {audioReady ? <span className="text-xs">🎧 有回放</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
