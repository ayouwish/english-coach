import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { createFamilyMember, listFamilyMembers } from "@/lib/family";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/family/members —— 家庭成员列表（仅家长）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  await requireParent();
  const items = await listFamilyMembers();
  return jsonOk({ items, count: items.length });
});

/** POST /api/family/members —— 新建成员（仅家长；login 可写简称，自动补 @family.local）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireParent();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonOk({ error: { code: "bad_request", message: "请求体必须是 JSON" } }, 400);
  const member = await createFamilyMember({
    displayName: body.display_name,
    login: body.login,
    password: body.password,
    role: body.role,
    cefrLevel: body.cefr_level,
    birthYear: body.birth_year,
    avatar: body.avatar,
    dailyLimitMinutes: body.daily_limit_minutes,
    allowFreeChat: body.allow_free_chat,
  });
  return jsonOk({ ok: true, member }, 201);
});
