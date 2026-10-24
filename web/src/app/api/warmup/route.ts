import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { getPrefs } from "@/lib/prefs";
import { callWarmup, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";

const MAX_TEXTS = 12;

/**
 * POST /api/warmup —— 参考音静默预热（契约 §12）。
 *
 * 前台是 fire-and-forget：不播放、不 loading、失败静默忽略，所以这里
 * **永远返回 200**（voice 不可达时 `ok:false`，调用方不看结果）。
 * 串行：`concurrency` 固定为 1（云 TTS 免费层并发=1）。
 */
export const POST = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();

  const body = (await req.json().catch(() => null)) as
    | { texts?: string[]; text?: string; rate?: "slow" | "normal"; voice?: string | null }
    | null;
  if (!body) throw new HttpError(400, "bad_request", "请求体必须是 JSON");

  const rawTexts = Array.isArray(body.texts) ? body.texts : body.text ? [body.text] : [];
  const texts = rawTexts
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t.length > 0 && t.length <= 2000)
    .slice(0, MAX_TEXTS);
  if (texts.length === 0) throw new HttpError(400, "bad_request", "texts 不能为空（1–12 条，每条 ≤2000 字符）");

  const prefs = await getPrefs(user.id);
  const rate = body.rate ?? prefs.ttsRate ?? "normal";
  const voice = body.voice !== undefined ? body.voice : prefs.ttsVoice ?? null;
  const items = texts.map((text) => ({ text, voice, rate }));

  try {
    const result = await callWarmup(items, 1);
    return jsonOk({
      ok: true,
      requested: result.requested,
      generated: result.generated,
      cached: result.cached,
      failed: result.failed?.length ?? 0,
      skipped_duplicates: result.skipped_duplicates,
      elapsed_ms: result.elapsed_ms,
      cache: result.cache ?? null,
    });
  } catch (err) {
    // 预热失败不是错误路径：让前端静默忽略即可
    const reason = err instanceof VoiceError ? err.code : "unknown";
    console.warn(`[warmup] 静默失败（${reason}）：${texts.length} 条`);
    return jsonOk({
      ok: false,
      reason,
      requested: items.length,
      generated: 0,
      cached: 0,
      failed: items.length,
      skipped_duplicates: 0,
      elapsed_ms: 0,
      cache: null,
    });
  }
});
