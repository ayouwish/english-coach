import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { getInviteInfo } from "@/lib/families";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/family/invite —— 家庭邀请码（仅家长）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireParent();
  return jsonOk(await getInviteInfo(user));
});
