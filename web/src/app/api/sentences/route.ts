import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import {
  createCustomSentence,
  createCustomSentencesBatch,
  listVisibleSentenceRows,
  toSentenceView,
  type Level,
} from "@/lib/corpus";
import { resolveFocus, isMinimalPairSentence } from "@/lib/focus";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

function safeArr(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/sentences —— 跟读语料。
 * 归属隔离（task-5 B.10）：官方语料 + （家长）自己录入的 + （儿童）家长录入的；
 * 其他家长的自定义语料不可见。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const level = req.nextUrl.searchParams.get("level");
  const focusRaw = req.nextUrl.searchParams.get("focus");
  const focus = resolveFocus(focusRaw);
  // 用原始行过滤（儿童视图的 focus_phonemes 会被剥离，不能拿来过滤）
  let rows = await listVisibleSentenceRows(user, { level: level ? level.toUpperCase() : null });
  const mineOnly = req.nextUrl.searchParams.get("mine") === "1";
  if (mineOnly) rows = rows.filter((r) => r.ownerUserId === user.id);

  // 强化练习队列（task-16 C）：只留 focus_phonemes 含该音素的句子，最小对立对优先
  if (focus.ipa) {
    rows = rows
      .filter((r) => {
        try {
          return (JSON.parse(r.focusPhonemes) as string[]).includes(focus.ipa as string);
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const pa = isMinimalPairSentence(safeArr(a.tags)) ? 0 : 1;
        const pb = isMinimalPairSentence(safeArr(b.tags)) ? 0 : 1;
        return pa !== pb ? pa - pb : a.sortOrder - b.sortOrder;
      });
  }
  const list = rows.map((r) => toSentenceView(r, user));

  return jsonOk({
    level: level ?? null,
    focus: focus.ipa ? { active: true, label: focus.label, phoneme: user.isChild ? null : focus.ipa } : { active: false },
    count: list.length,
    user_level: user.cefrLevel,
    official_count: list.filter((r) => r.owner_user_id === null).length,
    custom_count: list.filter((r) => r.owner_user_id !== null).length,
    mine_count: list.filter((r) => r.mine).length,
    sentences: list,
  });
});

/** POST /api/sentences —— 家长录入自定义语料（单条，或 batch 批量粘贴）。 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as
    | {
        text?: string;
        translation_zh?: string;
        level?: string;
        focus_phonemes?: string[] | string;
        tags?: string[];
        batch?: string;
      }
    | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

  // 批量粘贴：每行一句，可只填英文（翻译可留空；用 Tab 或 | 分隔）
  if (typeof body.batch === "string" && body.batch.trim()) {
    const result = await createCustomSentencesBatch(
      user,
      body.batch.split(/\r?\n/),
      (body.level?.toUpperCase() as Level) ?? "A1",
    );
    return jsonOk(
      {
        created_count: result.created.length,
        skipped_count: result.skipped.length,
        skipped: result.skipped,
        created: result.created,
      },
      201,
    );
  }

  const created = await createCustomSentence(user, {
    text: body.text ?? "",
    translation_zh: body.translation_zh,
    level: body.level,
    focus_phonemes: body.focus_phonemes,
    tags: body.tags,
  });
  return jsonOk({ created }, 201);
});
