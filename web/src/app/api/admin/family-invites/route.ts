import { ensureBootstrap } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { createAdminFamilyInvite, listAdminFamilyInvites } from "@/lib/admin-family-invites";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** 后台：新家庭邀请码列表（task-111）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  await requireAdmin();
  return jsonOk(await listAdminFamilyInvites());
});

/** 后台：生成新家庭邀请码（原子扣减名额；quota=0 → 403 no_family_quota）。 */
export const POST = route(async () => {
  await ensureBootstrap();
  await requireAdmin();
  return jsonOk({ ok: true, ...(await createAdminFamilyInvite()) }, 201);
});
