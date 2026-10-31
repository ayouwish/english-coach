import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatMessages, chatScenarios, chatSessions } from "@/db/schema";
import { ChatSessionAudio } from "@/components/ChatSessionAudio";
import { PronunciationNote } from "@/components/PronunciationNote";
import { parsePron } from "@/lib/chat-pronunciation";
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
    </div>
  );
}
