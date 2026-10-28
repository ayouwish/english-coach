import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireParent } from "@/lib/auth";
import { listSuggestions, suggestionsToMarkdown } from "@/lib/suggestions";

export const dynamic = "force-dynamic";

/**
 * GET /api/suggestions/export?format=md|json&status= —— 家长导出（任务要求"至少支持复制 Markdown"）。
 * Markdown 直接下载成文件，方便贴给 AI/开发者继续优化。
 */
export async function GET(req: NextRequest) {
  try {
    await ensureBootstrap();
    await requireParent();
    const sp = req.nextUrl.searchParams;
    const format = sp.get("format") === "json" ? "json" : "md";
    const data = await listSuggestions({ status: sp.get("status"), limit: 200, offset: 0 });
    const generatedAt = new Date().toISOString();
    const stamp = generatedAt.slice(0, 16).replace(/[-:T]/g, "");

    if (format === "json") {
      return new NextResponse(
        JSON.stringify({ generated_at: generatedAt, counts: data.counts, total: data.total, items: data.items }, null, 2),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="suggestions-${stamp}.json"`,
            "cache-control": "no-store",
          },
        },
      );
    }

    const md = suggestionsToMarkdown(data.items, {
      generatedAt,
      counts: data.counts,
      total: data.total,
    });
    return new NextResponse(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="suggestions-${stamp}.md"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "导出失败";
    return NextResponse.json({ error: { code: "forbidden", message, detail: {} } }, { status });
  }
}
