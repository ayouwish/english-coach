import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getPrefs, effectiveShowWordIpa } from "@/lib/prefs";
import { lookupWordIpa, WordIpaValidationError, VoiceError } from "@/lib/word-ipa";

export const dynamic = "force-dynamic";

/**
 * GET /api/words/:word —— 单词音标（task-87）。
 * 儿童默认**不返回 IPA**（零 IPA 规则）；家长在设置里打开后儿童才拿到（child-ipa 守卫按设置豁免）。
 * 未收录 → 404 `{word, ipa:null}`（前端显示「暂无音标，可听发音」，不报错）。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ word: string }> }) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const { word } = await ctx.params;
    const prefs = await getPrefs(user.id, user.isChild);
    const showIpa = effectiveShowWordIpa(prefs, user.isChild);
    const result = await lookupWordIpa(word);
    if (!showIpa) {
      // 儿童（或关闭开关）：不给 IPA，但仍告知"这是哪个词"（前端只显示 🔊）
      return NextResponse.json({ word: result.word, ipa: null, ipa_disabled: true, variants: [], source: null, syllables: null }, { status: 200 });
    }
    if (!result.ipa) {
      return NextResponse.json({ word: result.word, ipa: null, variants: [], source: null, syllables: null }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof WordIpaValidationError) {
      return NextResponse.json({ error: { code: "bad_request", message: err.message, detail: {} } }, { status: 400 });
    }
    if (err instanceof VoiceError) {
      const unavailable = err.code === "voice_unreachable" || err.status === 404 || err.status === 503 || err.status === 504;
      console.warn(`[words] voice 不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
      return NextResponse.json(
        {
          error: {
            code: unavailable ? "word_ipa_unavailable" : "provider_error",
            message: unavailable ? "音标服务暂时不可用；可以先点 🔊 听发音。" : `查询音标失败：${err.message}`,
            detail: {},
          },
        },
        { status: unavailable ? 503 : 502 },
      );
    }
    console.error("[words.get]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "查询音标失败", detail: {} } }, { status: 500 });
  }
}
