import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import {
  createCustomSentence,
  createCustomSentencesBatch,
  listVisibleSentences,
  type Level,
} from "@/lib/corpus";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/sentences —— 跟读语料。
 * 归属隔离（task-5 B.10）：官方语料 + （家长）自己录入的 + （儿童）家长录入的；
 * 其他家长的自定义语料不可见。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const level = req.nextUrl.searchParams.get("level");
  const rows = await listVisibleSentences(user, { level: level ? level.toUpperCase() : null });
  const mineOnly = req.nextUrl.searchParams.get("mine") === "1";
  const list = mineOnly ? rows.filter((r) => r.mine) : rows;

  return jsonOk({
    level: level ?? null,
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
