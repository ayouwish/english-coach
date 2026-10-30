/**
 * 语料归属与可见性（契约 v1.1 §13.2 / task-5 B）。
 *
 * 规则：官方语料（owner_user_id IS NULL）所有人可见；
 *       家长自定义语料（source='parent'）只有「录入者本人 + 其孩子」可见可用。
 * 本应用是单家庭部署，所以"其孩子"= 家庭里 role='child' 的用户。
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, sentences, users } from "@/db/schema";
import { HttpError, type SessionUser } from "./auth";

// 统一用 CEFR_LEVELS（含 B2）：语料已扩到 600 句、新增 B2，
// 这里若仍写死 A1/A2/B1，家长自定义语料的 POST 校验会拒掉 B2，且 UI 缺 B2 过滤入口。
import { CEFR_LEVELS } from "@/lib/levels";

export const LEVELS = CEFR_LEVELS;
export type Level = (typeof LEVELS)[number];

/** 该用户能看到的自定义语料归属者集合。 */
export async function visibleOwnerIds(user: SessionUser): Promise<string[]> {
  if (user.role === "parent") return [user.id];
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "parent"));
  return rows.map((r) => r.id);
}

/** drizzle where 条件：官方 + 可见的自定义语料。 */
export async function visibleSentencesWhere(user: SessionUser) {
  const owners = await visibleOwnerIds(user);
  const visible =
    owners.length > 0
      ? or(isNull(sentences.ownerUserId), inArray(sentences.ownerUserId, owners))
      : isNull(sentences.ownerUserId);
  // 连读模式里"用户自己贴的句子"只用于归属那条 attempt，不进语料库/练习列表
  return and(visible, ne(sentences.source, "flow-custom"));
}

export interface SentenceView {
  id: string;
  text: string;
  translation_zh: string;
  level: string;
  tags: string[];
  focus_phonemes: string[];
  source: string;
  owner_user_id: string | null;
  mine: boolean;
  sort_order: number;
}

export function toSentenceView(
  row: typeof sentences.$inferSelect,
  user: SessionUser,
): SentenceView {
  return {
    id: row.id,
    text: row.text,
    translation_zh: row.translationZh,
    level: row.level,
    tags: safeArray(row.tags),
    // 儿童不接收 IPA（focus_phonemes 是音素符号）
    focus_phonemes: user.isChild ? [] : safeArray(row.focusPhonemes),
    source: row.source,
    owner_user_id: row.ownerUserId,
    mine: row.ownerUserId === user.id,
    sort_order: row.sortOrder,
  };
}

/** 可见语料的**原始行**（含完整 focus_phonemes，即使请求者是儿童）——仅供服务端过滤用 */
export async function listVisibleSentenceRows(
  user: SessionUser,
  opts: { level?: string | null } = {},
) {
  const db = getDb();
  const visible = await visibleSentencesWhere(user);
  const where = opts.level ? and(visible, eq(sentences.level, opts.level)) : visible;
  return db.select().from(sentences).where(where).orderBy(asc(sentences.sortOrder));
}

export async function listVisibleSentences(
  user: SessionUser,
  opts: { level?: string | null } = {},
): Promise<SentenceView[]> {
  const rows = await listVisibleSentenceRows(user, opts);
  return rows.map((r) => toSentenceView(r, user));
}

export interface CreateSentenceInput {
  text: string;
  translation_zh?: string;
  level?: string;
  focus_phonemes?: string[] | string;
  tags?: string[];
}

function normalizePhonemes(input: CreateSentenceInput["focus_phonemes"]): string[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : input.split(/[\s,;，、]+/);
  return list.map((p) => p.trim()).filter(Boolean).slice(0, 8);
}

export function validateSentenceInput(raw: CreateSentenceInput): {
  text: string;
  translationZh: string;
  level: Level;
  focusPhonemes: string[];
  tags: string[];
} {
  const text = (raw.text ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw new HttpError(400, "bad_request", "英文句子不能为空");
  if (text.length > 200) throw new HttpError(400, "bad_request", "句子过长（上限 200 字符）");
  const translationZh = (raw.translation_zh ?? "").trim();
  if (translationZh.length > 200) throw new HttpError(400, "bad_request", "翻译过长（上限 200 字符）");
  const level = ((raw.level ?? "A1").toUpperCase() as Level) ?? "A1";
  if (!LEVELS.includes(level)) {
    throw new HttpError(400, "bad_request", `level 必须是 ${LEVELS.join("/")}`);
  }
  return {
    text,
    translationZh,
    level,
    focusPhonemes: normalizePhonemes(raw.focus_phonemes),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6) : [],
  };
}

/** 家长录入自定义语料（source='parent'，归属本人）。 */
export async function createCustomSentence(
  user: SessionUser,
  raw: CreateSentenceInput,
): Promise<SentenceView> {
  if (user.role !== "parent") {
    throw new HttpError(403, "forbidden", "只有家长可以录入自定义语料");
  }
  const v = validateSentenceInput(raw);
  const db = getDb();
  const id = `s-custom-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${sentences.sortOrder}), 0)` })
    .from(sentences);
  const nextOrder = Number(maxRow?.max ?? 0) + 1;

  await db.insert(sentences).values({
    id,
    text: v.text,
    translationZh: v.translationZh,
    level: v.level,
    tags: JSON.stringify(v.tags),
    focusPhonemes: JSON.stringify(v.focusPhonemes),
    source: "parent",
    ownerUserId: user.id,
    sortOrder: nextOrder,
  });

  const [row] = await db.select().from(sentences).where(eq(sentences.id, id)).limit(1);
  return toSentenceView(row, user);
}

/** 批量粘贴：每行一句，英文必填、翻译可留空（用制表符或 "|" 分隔）。 */
export async function createCustomSentencesBatch(
  user: SessionUser,
  lines: string[],
  level: Level = "A1",
): Promise<{ created: SentenceView[]; skipped: { line: string; reason: string }[] }> {
  if (user.role !== "parent") {
    throw new HttpError(403, "forbidden", "只有家长可以录入自定义语料");
  }
  const created: SentenceView[] = [];
  const skipped: { line: string; reason: string }[] = [];
  for (const rawLine of lines.slice(0, 200)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\t|\s*\|\s*/);
    const text = parts[0]?.trim() ?? "";
    const translation = parts.slice(1).join(" ").trim();
    if (!text) {
      skipped.push({ line, reason: "缺少英文句子" });
      continue;
    }
    try {
      created.push(
        await createCustomSentence(user, { text, translation_zh: translation, level }),
      );
    } catch (err) {
      skipped.push({ line, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, skipped };
}

/** 删除自己录的语料（官方语料与他人语料不可删）。 */
export async function deleteCustomSentence(user: SessionUser, id: string): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(sentences).where(eq(sentences.id, id)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "语料不存在");
  if (row.ownerUserId !== user.id) {
    throw new HttpError(403, "forbidden", "只能删除自己录入的语料");
  }
  await db.delete(sentences).where(eq(sentences.id, id));
}

/** 该用户"练过"的句子 id（盲测抽题用；排除盲测自身产生的记录）。 */
export async function practicedSentenceIds(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ sentenceId: attempts.sentenceId })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.isBlind, 0)));
  return rows.map((r) => r.sentenceId).filter((x): x is string => Boolean(x));
}

function safeArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
