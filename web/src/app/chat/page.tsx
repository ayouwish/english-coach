import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatScenarios } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getCapabilities } from "@/lib/voice";
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
  const visible = user.isChild ? rows.filter((r) => r.minAge <= age) : rows;
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  const caps = await getCapabilities();

  return (
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
      voiceReachable={caps.reachable}
    />
  );
}
