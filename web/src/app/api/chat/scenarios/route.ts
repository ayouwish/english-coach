import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatScenarios, userScenarios } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ageOf, audienceForUser, isScenarioAllowedFor, scenarioAudience } from "@/lib/chat";
import {
  listCustomScenarios,
  mirrorCustomScenario,
  parseVariants,
  validateCustomScenario,
  type CustomScenarioInput,
} from "@/lib/custom-scenarios";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/scenarios：内置场景（按 audience + min_age 过滤）+ **当前用户的自定义场景**。
 * `?include_child=1`（**仅成人有效**）→ 成人额外拿到儿童场景；儿童传了也忽略。
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
  const visible = rows.filter((r) => {
    const tags = JSON.parse(r.tags) as string[];
    if (tags.includes("custom")) return false; // task-79：自定义场景由 user_scenarios 出，避免重复
    const aud = scenarioAudience(tags);
    if (aud === "adult" && wanted !== "adult") return false;
    if (aud === wanted) return isScenarioAllowedFor(user, r.minAge);
    if (includeChild && aud === "child") return true;
    return false;
  });

  // task-79：合并「当前用户的自定义场景」（自定义优先，is_custom:true）
  const custom = (await listCustomScenarios(user.id))
    .filter((c) => c.audience === wanted)
    .map((c) => {
      const variants = parseVariants(c.variantsJson);
      return {
        id: c.id,
        audience: (c.audience === "child" ? "child" : "adult") as "child" | "adult",
        is_custom: true,
        title: c.title,
        title_zh: c.titleZh,
        setting_zh: c.settingZh,
        opening_line: variants[0]?.opening_line ?? c.openingLine,
        level: c.level,
        min_age: 0,
        tags: ["custom"],
        variation_count: variants.length,
      };
    });

  return jsonOk({
    age,
    is_child: user.isChild,
    audience: wanted,
    include_child: includeChild,
    count: visible.length + custom.length,
    custom_count: custom.length,
    hidden_count: rows.length - visible.length,
    scenarios: [
      ...custom,
      ...visible.map((r) => ({
        id: r.id,
        audience: scenarioAudience(JSON.parse(r.tags) as string[]),
        is_custom: false,
        title: r.title,
        title_zh: r.titleZh,
        setting_zh: r.settingZh,
        opening_line: r.openingLine,
        level: r.level,
        min_age: r.minAge,
        tags: JSON.parse(r.tags) as string[],
        variation_count: 0,
      })),
    ],
  });
});

/** POST /api/chat/scenarios —— 创建自定义场景（儿童强制 child；禁止注入词）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as CustomScenarioInput | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");
  const input = validateCustomScenario(body, user.isChild);
  const id = `us_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const now = new Date().toISOString();
  await getDb().insert(userScenarios).values({
    id,
    ownerId: user.id,
    title: input.title,
    titleZh: input.titleZh,
    settingZh: input.settingZh,
    rolePrompt: input.rolePrompt,
    openingLine: input.openingLine,
    level: input.level,
    audience: input.audience,
    variantsJson: input.variantsJson,
    createdAt: now,
    updatedAt: now,
  });
  await mirrorCustomScenario({
    id,
    ownerId: user.id,
    title: input.title,
    titleZh: input.titleZh,
    settingZh: input.settingZh,
    rolePrompt: input.rolePrompt,
    openingLine: input.openingLine,
    level: input.level,
    audience: input.audience,
  });
  return jsonOk({ ok: true, id, is_custom: true, audience: input.audience }, 201);
});
