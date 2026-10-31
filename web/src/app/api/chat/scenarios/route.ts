import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatScenarios } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { ageOf, audienceForUser, isScenarioAllowedFor, scenarioAudience } from "@/lib/chat";
import { NextRequest } from "next/server";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/scenarios：按 audience + min_age 过滤。
 * `?include_child=1`（**仅成人有效**）→ 成人额外拿到儿童场景（带 audience 便于前端分组）；
 * 儿童传了也**忽略**（仍只返回 child，不泄漏 adult）。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const rows = await getDb()
    .select()
    .from(chatScenarios)
    .where(eq(chatScenarios.enabled, 1))
    .orderBy(asc(chatScenarios.sortOrder));

  const age = ageOf(user);
  const wanted = audienceForUser(user);
  const includeChild = wanted === "adult" && req.nextUrl.searchParams.get("include_child") === "1";
  // task-68：儿童只看儿童场景；成人默认只看成人场景，开关打开时追加儿童场景
  const visible = rows.filter((r) => {
    const tags = JSON.parse(r.tags) as string[];
    const aud = scenarioAudience(tags);
    if (aud === "adult" && wanted !== "adult") return false; // 儿童永远拿不到成人场景
    if (aud === wanted) return isScenarioAllowedFor(user, r.minAge);
    if (includeChild && aud === "child") return true;
    return false;
  });

  return jsonOk({
    age,
    is_child: user.isChild,
    audience: wanted,
    include_child: includeChild,
    allow_free_chat: user.allowFreeChat,
    count: visible.length,
    hidden_count: rows.length - visible.length,
    scenarios: visible.map((r) => ({
      id: r.id,
      audience: scenarioAudience(JSON.parse(r.tags) as string[]),
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
