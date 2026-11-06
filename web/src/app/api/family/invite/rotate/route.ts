import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { rotateInviteCode } from "@/lib/families";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/family/invite/rotate —— 重置邀请码（仅家长；旧码立即失效）。 */
export const POST = route(async () => {
  await ensureBootstrap();
  const user = await requireParent();
  const family = await rotateInviteCode(user);
  return jsonOk({ ok: true, family_name: family.name, invite_code: family.inviteCode });
});
