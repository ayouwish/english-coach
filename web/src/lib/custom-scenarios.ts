/**
 * 场景变体 + 用户自定义场景（task-79）。
 *
 * - 内置场景的变体在 `src/data/scenarios.json` 的 `variations`（构建期 import，运行时随机抽一组）
 * - 自定义场景存在 `user_scenarios`（仅 owner 可见/可改；儿童强制 child）
 * - 会话存 `variation_json`：历史回看用**当时抽到的那组**，不重新随机
 */
import bundled from "@/data/scenarios.json";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatScenarios, userScenarios } from "@/db/schema";
import { HttpError } from "@/lib/auth";

export interface ScenarioVariation {
  persona: string;
  place: string;
  detail: string;
  goal: string;
  opening_line: string;
}

interface BundledScenario {
  id: string;
  title: string;
  title_zh: string;
  setting_zh: string;
  role_prompt: string;
  opening_line: string;
  level: string;
  min_age: number;
  tags: string[];
  sort_order: number;
  variations?: ScenarioVariation[];
}

const BUNDLED = (bundled as { scenarios: BundledScenario[] }).scenarios;
const BY_ID = new Map(BUNDLED.map((s) => [s.id, s]));

export function bundledScenario(id: string): BundledScenario | null {
  return BY_ID.get(id) ?? null;
}

/** 随机抽一组变体；没有变体时返回 null（用固定 opening_line） */
export function pickVariation(variations: ScenarioVariation[] | null | undefined): ScenarioVariation | null {
  if (!variations || variations.length === 0) return null;
  return variations[Math.floor(Math.random() * variations.length)] ?? null;
}

export function builtinVariations(scenarioId: string): ScenarioVariation[] {
  return BY_ID.get(scenarioId)?.variations ?? [];
}

/** 自定义场景的变体（variants_json 可选；没有就 null → 固定开场白） */
export function parseVariants(raw: string | null): ScenarioVariation[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({
        persona: String(x.persona ?? ""),
        place: String(x.place ?? ""),
        detail: String(x.detail ?? ""),
        goal: String(x.goal ?? ""),
        opening_line: String(x.opening_line ?? ""),
      }))
      .filter((x) => x.opening_line.trim().length > 0);
  } catch {
    return [];
  }
}

export interface CustomScenarioRow {
  id: string;
  ownerId: string;
  title: string;
  titleZh: string;
  settingZh: string;
  rolePrompt: string;
  openingLine: string;
  level: string;
  audience: string;
  variantsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listCustomScenarios(ownerId: string): Promise<CustomScenarioRow[]> {
  const rows = await getDb()
    .select()
    .from(userScenarios)
    .where(eq(userScenarios.ownerId, ownerId))
    .orderBy(desc(userScenarios.createdAt))
    .limit(50);
  return rows as CustomScenarioRow[];
}

export async function getCustomScenario(ownerId: string, id: string): Promise<CustomScenarioRow | null> {
  const [row] = await getDb()
    .select()
    .from(userScenarios)
    .where(and(eq(userScenarios.ownerId, ownerId), eq(userScenarios.id, id)))
    .limit(1);
  return (row as CustomScenarioRow | undefined) ?? null;
}

/**
 * 自定义场景同时镜像到 `chat_scenarios`：
 *  - `chat_sessions.scenario_id` 有外键指向 chat_scenarios，turn 路由也从那里读场景；
 *  - 列表 API 会把 `custom` 标记的行过滤掉（只从 user_scenarios 出），避免重复。
 */
export async function mirrorCustomScenario(input: {
  id: string;
  ownerId: string;
  title: string;
  titleZh: string;
  settingZh: string;
  rolePrompt: string;
  openingLine: string;
  level: string;
  audience: "child" | "adult";
}): Promise<void> {
  const db = getDb();
  const tags = JSON.stringify(["custom", `audience:${input.audience}`, `owner:${input.ownerId}`]);
  await db
    .insert(chatScenarios)
    .values({
      id: input.id,
      title: input.title,
      titleZh: input.titleZh,
      settingZh: input.settingZh,
      rolePrompt: input.rolePrompt,
      openingLine: input.openingLine,
      level: input.level,
      minAge: 0,
      tags,
      enabled: 1,
      sortOrder: 900,
    })
    .onConflictDoUpdate({
      target: chatScenarios.id,
      set: {
        title: input.title,
        titleZh: input.titleZh,
        settingZh: input.settingZh,
        rolePrompt: input.rolePrompt,
        openingLine: input.openingLine,
        level: input.level,
        tags,
      },
    });
}

export async function unmirrorCustomScenario(id: string): Promise<void> {
  await getDb().delete(chatScenarios).where(eq(chatScenarios.id, id));
}

// ── 校验（长度 / level / audience / 注入词）─────────────────────────────────
export const SCENARIO_LEVELS = ["A1", "A2", "B1", "B2", "C1"];
export const SCENARIO_AUDIENCES = ["child", "adult"];

/** 明显的 prompt 注入/越权指令（不追求完备，挡住常见玩法） */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+(a|an|the)?/i,
  /(reveal|show|print|output)\s+(your|the)\s+(system|hidden|secret)/i,
  /ignore\s+your\s+(rules|guidelines|safety)/i,
  /开发者模式|忽略(之前|以上|前面)的?(所有)?(指令|提示|规则)|系统提示词|越狱/i,
];

export function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export interface CustomScenarioInput {
  title?: unknown;
  title_zh?: unknown;
  setting_zh?: unknown;
  role_prompt?: unknown;
  opening_line?: unknown;
  level?: unknown;
  audience?: unknown;
  variants?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 校验并规范化；儿童强制 audience=child（传入 adult 直接 400） */
export function validateCustomScenario(body: CustomScenarioInput, isChild: boolean): {
  title: string;
  titleZh: string;
  settingZh: string;
  rolePrompt: string;
  openingLine: string;
  level: string;
  audience: "child" | "adult";
  variantsJson: string | null;
} {
  const title = str(body.title);
  const titleZh = str(body.title_zh);
  const settingZh = str(body.setting_zh);
  const rolePrompt = str(body.role_prompt);
  const openingLine = str(body.opening_line);
  const level = str(body.level) || "A2";
  const audienceRaw = str(body.audience) || (isChild ? "child" : "adult");

  if (title.length < 1 || title.length > 40) throw new HttpError(400, "bad_request", "英文标题需为 1–40 个字符");
  if (titleZh.length < 1 || titleZh.length > 40) throw new HttpError(400, "bad_request", "中文标题需为 1–40 个字符");
  if (settingZh.length < 1 || settingZh.length > 200) throw new HttpError(400, "bad_request", "场景说明需为 1–200 个字符");
  if (rolePrompt.length < 20 || rolePrompt.length > 1500) throw new HttpError(400, "bad_request", "角色设定需为 20–1500 个字符");
  if (openingLine.length < 5 || openingLine.length > 200) throw new HttpError(400, "bad_request", "开场白需为 5–200 个字符");
  if (!SCENARIO_LEVELS.includes(level)) throw new HttpError(400, "bad_request", `难度必须是 ${SCENARIO_LEVELS.join("/")}`);
  if (!SCENARIO_AUDIENCES.includes(audienceRaw)) throw new HttpError(400, "bad_request", "audience 必须是 child/adult");
  if (isChild && audienceRaw !== "child") throw new HttpError(400, "bad_request", "儿童账号只能创建「小朋友」场景");
  if (containsInjection(rolePrompt) || containsInjection(openingLine) || containsInjection(settingZh)) {
    throw new HttpError(400, "bad_request", "角色设定/开场白里有不允许的指令词，改一下试试");
  }
  const variants = Array.isArray(body.variants)
    ? (body.variants as unknown[])
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((x) => ({
          persona: str(x.persona),
          place: str(x.place),
          detail: str(x.detail),
          goal: str(x.goal),
          opening_line: str(x.opening_line) || openingLine,
        }))
        .filter((x) => x.opening_line.length >= 5 && x.opening_line.length <= 200)
        .slice(0, 5)
    : [];
  return {
    title,
    titleZh,
    settingZh,
    rolePrompt,
    openingLine,
    level,
    audience: audienceRaw as "child" | "adult",
    variantsJson: variants.length > 0 ? JSON.stringify(variants) : null,
  };
}
