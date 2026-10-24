import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatScenarios } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { ageOf, isScenarioAllowedFor } from "@/lib/chat";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/chat/scenarios：按 min_age 过滤（儿童只能看到适龄场景）。 */
export const GET = route(async () => {
  await ensureBootstrap();
  const user = await requireUser();
  const rows = await getDb()
    .select()
    .from(chatScenarios)
    .where(eq(chatScenarios.enabled, 1))
    .orderBy(asc(chatScenarios.sortOrder));

  const age = ageOf(user);
  const visible = rows.filter((r) => isScenarioAllowedFor(user, r.minAge));

  return jsonOk({
    age,
    is_child: user.isChild,
    allow_free_chat: user.allowFreeChat,
    count: visible.length,
    hidden_count: rows.length - visible.length,
    scenarios: visible.map((r) => ({
      id: r.id,
      title: r.title,
      title_zh: r.titleZh,
      setting_zh: r.settingZh,
      opening_line: r.openingLine,
      level: r.level,
      min_age: r.minAge,
      tags: JSON.parse(r.tags) as string[],
    })),
  });
});
