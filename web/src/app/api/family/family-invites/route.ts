import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { createFamilyInvite, listFamilyInvites } from "@/lib/families";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/family/family-invites —— 本家庭生成的新家庭邀请码（仅管理员家庭）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireParent();
  return jsonOk(await listFamilyInvites(user));
});

/** POST /api/family/family-invites —— 生成新家庭邀请码（原子扣减 1 个名额）。 */
export const POST = route(async () => {
  await ensureBootstrap();
  const user = await requireParent();
  const result = await createFamilyInvite(user);
  return jsonOk({ ok: true, ...result }, 201);
});
