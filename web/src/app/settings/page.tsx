import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { listVisibleSentences } from "@/lib/corpus";
import { getPrefs } from "@/lib/prefs";
import { getDailyUsage } from "@/lib/usage";
import { AvatarSection } from "@/components/AvatarSection";
import { CorpusManager } from "./CorpusManager";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const prefs = await getPrefs(user.id, user.isChild);
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  const mySentences = user.role === "parent"
    ? (await listVisibleSentences(user)).filter((s) => s.mine)
    : [];

  return (
    <>
    <SettingsForm
      user={{
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        ageBand: user.ageBand,
        cefrLevel: user.cefrLevel,
        dailyLimitMinutes: user.dailyLimitMinutes,
        allowFreeChat: user.allowFreeChat,
        isChild: user.isChild,
      }}
      prefs={prefs}
      usage={usage}
    />
    <AvatarSection isChild={user.isChild} />
    {user.role === "parent" ? <CorpusManager initial={mySentences} /> : null}
    </>
  );
}
