import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireParent, requireUser } from "@/lib/auth";
import { getCapabilities } from "@/lib/voice";
import { jsonOk, route } from "@/lib/http";
import {
  createSuggestion,
  isSuggestionCategory,
  listSuggestions,
  MAX_SUGGESTION_LENGTH,
  normalizeSuggestionContent,
  pickPage,
  sanitizeContext,
  SuggestionValidationError,
} from "@/lib/suggestions";

export const dynamic = "force-dynamic";

/**
 * POST /api/suggestions —— 提交建议（**儿童也能提**，文案由前端做儿童友好）。
 * 服务端自己采集 user_id / user_role / page / context，不信客户端传的身份。
 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as
    | { category?: string; content?: string; page?: string; viewport?: { w?: number; h?: number } }
    | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

  if (!isSuggestionCategory(body.category)) {
    throw new HttpError(400, "bad_request", "请选择一个建议分类");
  }
  let content: string;
  try {
    content = normalizeSuggestionContent(body.content, user.isChild);
  } catch (err) {
    if (err instanceof SuggestionValidationError) throw new HttpError(400, "bad_request", err.message);
    throw err;
  }

  const caps = await getCapabilities();
  const id = await createSuggestion(user, {
    category: body.category,
    content,
    page: pickPage(req.headers.get("referer"), body.page),
    context: sanitizeContext({
      userAgent: req.headers.get("user-agent"),
      voiceMode: caps.mode,
      viewport: body.viewport,
    }),
  });

  // 儿童可见载荷零 IPA：响应只回 id/ok，不回显正文
  return jsonOk({ ok: true, id, max_length: MAX_SUGGESTION_LENGTH }, 201);
});

/** GET /api/suggestions —— **仅家长**；儿童 403。 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  await requireParent();
  const sp = req.nextUrl.searchParams;
  const data = await listSuggestions({
    status: sp.get("status"),
    limit: Number(sp.get("limit") ?? 50),
    offset: Number(sp.get("offset") ?? 0),
  });
  return jsonOk({
    ...data,
    generated_at: new Date().toISOString(),
    max_length: MAX_SUGGESTION_LENGTH,
  });
});
