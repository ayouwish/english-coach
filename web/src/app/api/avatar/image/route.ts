import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getAvatar, resolveAvatarPath } from "@/lib/avatar";
import { mimeForPath } from "@/lib/illustration";

export const dynamic = "force-dynamic";

/**
 * GET /api/avatar/image[?user=<id>] —— 虚拟形象图片（需登录）。
 * 默认取当前用户；带 `user` 时取家庭成员（家庭共享：故事卡片上显示作者头像）。
 */
export async function GET(req: NextRequest) {
  try {
    await ensureBootstrap();
    const user = await requireUser();
    const target = new URL(req.url).searchParams.get("user") ?? user.id;
    const state = await getAvatar(target);
    if (!state.image_path) throw new HttpError(404, "not_found", "还没有设置虚拟形象");
    // 预置形象是 public 下的静态图（task-64），直接从这里读
    const abs = state.image_path.startsWith("avatars/presets/")
      ? path.join(process.cwd(), "public", state.image_path)
      : resolveAvatarPath(state.image_path);
    if (!abs || !fs.existsSync(abs)) throw new HttpError(404, "not_found", "形象图片不存在");
    const stat = fs.statSync(abs);
    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": mimeForPath(state.image_path),
        "content-length": String(stat.size),
        "last-modified": new Date(stat.mtimeMs).toUTCString(),
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[avatar.image]", err);
    return NextResponse.json({ error: { code: "internal_error", message: "读取形象图片失败", detail: {} } }, { status: 500 });
  }
}
