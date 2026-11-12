import { clearAdminCookie } from "@/lib/admin-auth";
import { jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/logout —— 清管理员 cookie。 */
export async function POST() {
  await clearAdminCookie();
  return jsonOk({ ok: true });
}
