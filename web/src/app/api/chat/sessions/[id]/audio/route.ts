import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { chatSessions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import {
  chatAudioPaths,
  getChatAudioState,
  isChatAudioReady,
  readChatAudioMeta,
  shouldAutoRetry,
  triggerChatAudioBuild,
} from "@/lib/chat-audio";
import { jsonError, jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/sessions/:id/audio —— 整段对话音频（task-68 / task-72）。
 *
 * 语义（异步预生成后）：
 * - ready        → 200 `audio/wav`（读缓存，Accept-Ranges: none）
 * - building     → 202 `{status:"building"}`（不重复构建）
 * - 无缓存/未构建 → 触发后台构建 → 202
 * - failed       → 500 + 可读错误；`?force=1` → 后台重建 → 202
 *
 * 构建本身由 `lib/chat-audio` 去重；对话结束时已由 /end、turn done=true 用 `after()` 预生成，
 * 正常路径下这里应该直接命中缓存（几毫秒），而不是现拼。
 */
export const GET = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const force = req.nextUrl.searchParams.get("force") === "1";

  const db = getDb();
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  if (!session || session.userId !== user.id) throw new HttpError(404, "not_found", "会话不存在");

  const { audioFile } = chatAudioPaths(id);

  // 1) 命中缓存：轮数一致 + wav 在 → 直接返回文件
  if (!force && isChatAudioReady(id, session.turnCount)) {
    const data = fs.readFileSync(audioFile);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(data.byteLength),
        "accept-ranges": "none",
        "cache-control": "private, max-age=0, must-revalidate",
        "x-chat-audio-cache": "hit",
      },
    });
  }

  const meta = readChatAudioMeta(id);

  // 2) 上次失败：60s 内 / 连续失败 ≥3 次 → 不自动重试，直接给**真实原因**；
  //    只有 ?force=1 或超过 backoff 窗口才重建（避免 TTS 被刷到 429/503 的恶性循环）
  if (!force && meta?.status === "failed") {
    if (shouldAutoRetry(meta)) {
      // 超过 backoff 且失败次数 <3 → 允许一次自动重试
    } else {
      return jsonError(500, meta.error_code ?? "audio_failed", meta.error ?? "拼装对话音频出错了，请稍后再试");
    }
  }

  // 3) building / 无缓存 / 缓存过期 / force → 触发后台构建，立即 202
  //    trigger 会同步打上“构建中”标记（并发去重），所以轮询 status 不会看到旧的 failed。
  triggerChatAudioBuild(id, user.id, { force });

  const state = getChatAudioState(id, session.turnCount);
  return jsonOk(
    {
      status: "building",
      turn_count: state.turn_count,
      retry_after_ms: 2000,
      ...(force ? { forced: true } : {}),
    },
    202,
  );
});
