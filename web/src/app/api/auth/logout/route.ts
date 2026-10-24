import { clearSessionCookie } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await clearSessionCookie();
  return jsonOk({ ok: true });
});
