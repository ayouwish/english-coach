import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { buildReviewData } from "@/lib/review-data";
import { getCapabilities } from "@/lib/voice";
import { getDailyUsage } from "@/lib/usage";
import { ReviewClient } from "./ReviewClient";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const caps = await getCapabilities();
  const data = await buildReviewData({
    userId: user.id,
    isChild: user.isChild,
    limit: 20,
    phonemeLevel: caps.capabilities.phoneme_level,
    voiceReachable: caps.reachable,
  });
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);

  return (
    <ReviewClient
      isChild={user.isChild}
      data={data}
      capabilities={caps.capabilities}
      usage={usage}
    />
  );
}
