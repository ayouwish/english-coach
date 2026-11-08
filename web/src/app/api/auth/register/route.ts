import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { setSessionCookie } from "@/lib/auth";
import { registerAccount } from "@/lib/families";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register —— 公开注册（task-97）。
 * 无 invite_code → 创建新家庭（role=parent）；有 invite_code → 加入该家庭（共同家长）。
 * 孩子账号仍由家长在家庭内创建。
 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonOk({ error: { code: "bad_request", message: "请求体必须是 JSON" } }, 400);
  const result = await registerAccount({
    display_name: body.display_name,
    email: body.email,
    password: body.password,
    family_name: body.family_name,
    invite_code: body.invite_code,
    new_family_code: body.new_family_code,
  });
  await setSessionCookie(result.token, result.expiresAt);
  return jsonOk({ ok: true, user: result.user, token: result.token }, 201);
});
