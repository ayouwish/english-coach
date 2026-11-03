import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getPrefs, effectiveShowWordIpa } from "@/lib/prefs";
import { lookupWordIpa, WordIpaValidationError, VoiceError } from "@/lib/word-ipa";

export const dynamic = "force-dynamic";
const MAX_BATCH = 50;

/**
 * GET /api/words?words=a,b,c —— 批量音标（task-87，≤50、去重；给整句预取用）。
 * 未收录的词返回 ipa:null（不整体失败）；儿童默认全部 ipa:null。
 */
export async function GET(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const prefs = await getPrefs(user.id, user.isChild);
    const showIpa = effectiveShowWordIpa(prefs);
    const raw = (req.nextUrl.searchParams.get("words") ?? "").split(",");
    const words = [...new Set(raw.map((w) => w.trim()).filter(Boolean))];
    if (words.length === 0) throw new HttpError(400, "bad_request", "缺少 words 参数");
    if (words.length > MAX_BATCH) throw new HttpError(400, "bad_request", `一次最多 ${MAX_BATCH} 个词`);
    if (!showIpa) {
      return NextResponse.json({ words: words.map((w) => ({ word: w, ipa: null, ipa_disabled: true })) });
    }
    const results = await Promise.all(
      words.map(async (w) => {
        try {
          const r = await lookupWordIpa(w);
          return { word: r.word, ipa: r.ipa, syllables: r.syllables };
        } catch (err) {
          if (err instanceof WordIpaValidationError) return { word: w, ipa: null, error: "invalid" };
          if (err instanceof VoiceError) throw err;
          return { word: w, ipa: null };
        }
      }),
    );
    return NextResponse.json({ words: results });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof VoiceError) {
      const unavailable = err.code === "voice_unreachable" || err.status === 404 || err.status === 503 || err.status === 504;
      return NextResponse.json(
        { error: { code: unavailable ? "word_ipa_unavailable" : "provider_error", message: unavailable ? "音标服务暂时不可用，请稍后再试。" : `查询音标失败：${err.message}`, detail: {} } },
        { status: unavailable ? 503 : 502 },
      );
    }
    console.error("[words.batch]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "查询音标失败", detail: {} } }, { status: 500 });
  }
}
