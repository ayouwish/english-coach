import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { getDailyUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) return jsonOk({ user: null });
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  return jsonOk({ user, usage });
});
