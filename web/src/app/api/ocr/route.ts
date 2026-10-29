import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { jsonOk } from "@/lib/http";
import { callOcr, VoiceError } from "@/lib/voice";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB（契约）

/**
 * 服务端二次校验：不能只信 Content-Type。
 * 有人会把文本改名成 .jpg 上传（我们的守卫就测这个），必须按文件头判断。
 */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; // WEBP
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return true; // HEIC/AVIF
  return false;
}
const OCR_UNAVAILABLE_HINT =
  "识别服务当前不可用：voice 侧没有启用 OCR（可能未安装识别依赖，或服务未启动）。" +
  "可以先用「✍️ 自己输入一段」把书上的句子打进来，或稍后再试。";

/**
 * POST /api/ocr —— 拍照识别代理（task-26）。
 * - 登录即可用（儿童也行）
 * - 只收 image/*、≤10MB（服务端二次校验，不信客户端）
 * - **内存中转不落盘**：图片不会写进 data/
 * - voice 不可用/未实现 OCR 时，返回**可操作的中文错误**（绝不静默失败）
 */
export async function POST(req: NextRequest) {
  try {
    await ensureBootstrap();
    await requireUser();

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "bad_request", "请求必须是 multipart/form-data（字段名 image）");
    }
    const image = form.get("image");
    if (!(image instanceof File)) {
      throw new HttpError(400, "bad_request", "缺少图片文件（字段名 image）");
    }
    const mime = image.type || "";
    if (!mime.startsWith("image/")) {
      throw new HttpError(400, "bad_request", `只支持图片（当前是 ${mime || "未知类型"}）`);
    }
    if (image.size > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "payload_too_large", `图片太大（${(image.size / 1024 / 1024).toFixed(1)}MB），上限 10MB`);
    }

    const data = new Uint8Array(await image.arrayBuffer());
    if (!looksLikeImage(data)) {
      throw new HttpError(400, "bad_request", "这不是有效的图片文件（内容不是图片）。请重新拍照或选择图片。");
    }
    const result = await callOcr({ data, mime, filename: image.name || "page.jpg" });
    return jsonOk({
      provider: result.provider,
      text: result.text,
      lines: result.lines ?? [],
      width: result.width ?? null,
      height: result.height ?? null,
      elapsed_ms: result.elapsed_ms ?? null,
      warnings: result.warnings ?? [],
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, detail: {} } },
        { status: err.status },
      );
    }
    if (err instanceof VoiceError) {
      // 404/405 = voice 还没实现该端点；503/502 = 依赖没装或服务不可用 → 都按"当前部署未启用"处理
      const unavailable =
        err.code === "voice_unreachable" ||
        err.status === 404 ||
        err.status === 405 ||
        err.status === 502 ||
        err.status === 503 ||
        err.status === 504;
      if (unavailable) {
        console.warn(`[ocr] voice 侧不可用（${err.code}/${err.status ?? "-"}）：${err.message}`);
        return NextResponse.json(
          { error: { code: "ocr_unavailable", message: OCR_UNAVAILABLE_HINT, detail: { reason: err.code } } },
          { status: 503 },
        );
      }
      if (err.code === "payload_too_large") {
        return NextResponse.json(
          { error: { code: "payload_too_large", message: "图片太大，上限 10MB", detail: {} } },
          { status: 413 },
        );
      }
      return NextResponse.json(
        { error: { code: err.code, message: `识别失败：${err.message}。可以换一张更清晰的照片，或改用「自己输入一段」。`, detail: {} } },
        { status: 502 },
      );
    }
    console.error("[ocr]", err);
    return NextResponse.json(
      {
        error: {
          code: "internal_error",
          message: "识别服务出错了。可以换一张照片重试，或改用「自己输入一段」。",
          detail: {},
        },
      },
      { status: 500 },
    );
  }
}
