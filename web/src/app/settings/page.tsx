import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { listVisibleSentences } from "@/lib/corpus";
import { getPrefs } from "@/lib/prefs";
import { getDailyUsage } from "@/lib/usage";
import { AvatarSection } from "@/components/AvatarSection";
import { getAvatar, avatarView } from "@/lib/avatar";
import { loadAvatarPresets } from "@/lib/avatar-presets";
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
  // task-64：预置形象库与当前形象在服务端取好 → 首屏直接渲染选择题（无 loading 闪烁）
  const avatarPresets = await loadAvatarPresets();
  const avatarInitial = avatarView(await getAvatar(user.id), user.id);

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
    <AvatarSection isChild={user.isChild} initialPresets={avatarPresets} initialAvatar={avatarInitial} />
    {user.role === "parent" ? <CorpusManager initial={mySentences} /> : null}
    </>
  );
}
