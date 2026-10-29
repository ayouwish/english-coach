import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getMaterial, resolveMaterialPath } from "@/lib/materials";

export const dynamic = "force-dynamic";

/**
 * GET /api/materials/:id/image —— 书页缩略图/原图。
 * 路径**派生自数据库里的 image_path**（不是用户输入），并再次限定在 materials/ 内（防穿越）。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureBootstrap();
    await requireUser();
    const { id } = await ctx.params;
    const material = await getMaterial(id);
    if (!material || !material.imagePath) {
      throw new HttpError(404, "not_found", "这个书页没有保存图片");
    }
    const abs = resolveMaterialPath(material.imagePath);
    if (!abs || !fs.existsSync(abs)) throw new HttpError(404, "not_found", "图片文件不存在");
    const stat = fs.statSync(abs);
    const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(stat.size),
        "last-modified": new Date(stat.mtimeMs).toUTCString(),
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, detail: {} } }, { status: err.status });
    }
    console.error("[materials.image]", err);
    return NextResponse.json(
      { error: { code: "internal_error", message: "读取图片失败", detail: {} } },
      { status: 500 },
    );
  }
}
