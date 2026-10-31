import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { readingMaterials } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { base64ToBytes, MAX_ILLUSTRATION_BYTES, writeIllustration } from "@/lib/illustration";
import { getAvatar } from "@/lib/avatar";
import { getMaterial } from "@/lib/materials";
import { callIllustrate, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";

const UNAVAILABLE_HINT = "插画服务暂未就绪（voice 侧 /v1/image/illustrate 未配置或未启用）。可以先读故事，稍后再画。";
const UNSAFE_HINT = "这段话可能不适合画成图，换个说法或改一下故事再来试试。";

/**
 * POST /api/story/:id/illustrate —— 故事插画（task-53，代理 voice 智谱出图）。
 * - `?force=1` 或 body.force → 强制重生成（**替换**旧图，避免磁盘无限增长；有费用提示由 UI 负责）
 * - 成功：校验图片 magic bytes → 原子写 `DATA_DIR/materials/<id>.png` → 更新 image_path
 * - 失败：可读中文错误，**不写文件、不留半截文件**
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let oldImagePath: string | null = null;
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const material = await getMaterial(id);
    if (!material) throw new HttpError(404, "not_found", "找不到这个故事");
    oldImagePath = material.imagePath;

    const body = (await req.json().catch(() => ({}))) as { force?: unknown; style?: unknown };
    const force = req.nextUrl.searchParams.get("force") === "1" || body?.force === true;
    const style = typeof body?.style === "string" ? body.style : "watercolor";

    // task-62：把当前用户的虚拟形象（角色卡 + 风格）作为参考传给 voice
    const avatar = await getAvatar(user.id);
    const result = await callIllustrate({
      story_text: material.text,
      title_en: material.title,
      style,
      force,
      character_desc: avatar.character_desc,
      character_style: avatar.style,
    });

    const bytes = base64ToBytes(result.image_b64 ?? "");
    if (!bytes) throw new HttpError(502, "provider_error", "插画服务返回的数据无法解析，请稍后再试");
    if (bytes.byteLength > MAX_ILLUSTRATION_BYTES) {
      throw new HttpError(502, "provider_error", "生成的图片过大，请稍后再试");
    }
    const written = writeIllustration(material.id, bytes);
    if (!written.ok) throw new HttpError(502, "provider_error", written.reason);

    // 只有写成功之后才更新 image_path；「换一张」= 替换旧文件地址（旧图是同名文件，已覆盖）
    await getDb()
      .update(readingMaterials)
      .set({
        imagePath: written.relativePath,
        imagePrompt: typeof result.prompt_used === "string" ? result.prompt_used.slice(0, 2000) : null,
        imageCharacterUsed: (result as { character_used?: unknown }).character_used ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingMaterials.id, material.id));

    return NextResponse.json({
      ok: true,
      image_url: `/api/materials/${material.id}/image`,
      image_path: written.relativePath,
      mime: written.mime,
      provider: result.provider ?? null,
      model: result.model ?? null,
      size: result.size ?? null,
      elapsed_ms: result.elapsed_ms ?? null,
      warnings: result.warnings ?? [],
      // task-62：提示词可见 + 是否用了虚拟形象
      prompt_used: typeof result.prompt_used === "string" ? result.prompt_used : null,
      character_used: Boolean((result as { character_used?: unknown }).character_used),
      character_desc_used: avatar.character_desc,
      character_style_used: avatar.style,
      force,
    });
  } catch (err) {
    // 失败清理：如果写文件失败后 image_path 被改坏了，恢复成原值（这里没改过，保持兜底逻辑清晰）
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    if (err instanceof VoiceError) {
      // voice 契约：400 = content_unsafe（内容审核不放行）→ 单独给"换说法"提示
      if (err.status === 400) {
        return NextResponse.json({ error: { code: "content_unsafe", message: UNSAFE_HINT, detail: {} } }, { status: 400 });
      }
      const unavailable =
        err.code === "voice_unreachable" ||
        err.status === 404 ||
        err.status === 405 ||
        err.status === 503 ||
        err.status === 504;
      if (unavailable) {
        console.warn(`[illustrate] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return NextResponse.json(
          { error: { code: "illustration_unavailable", message: UNAVAILABLE_HINT, detail: { reason: err.code } } },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: { code: "provider_error", message: `画插画失败：${err.message}。可以点「再试一次」。`, detail: {} } },
        { status: 502 },
      );
    }
    console.error("[illustrate]", err);
    return NextResponse.json(
      { error: { code: "internal_error", message: "画插画出错了，可以点「再试一次」。", detail: {} } },
      { status: 500 },
    );
  } finally {
    // 注：替换模式下同名文件已被原子覆盖；若将来改成不同文件名，可在这里 deleteIllustration(oldImagePath)。
    void oldImagePath;
  }
}
