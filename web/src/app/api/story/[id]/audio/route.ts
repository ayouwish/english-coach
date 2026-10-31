import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import {
  getStoryAudioState,
  readStoryAudioMeta,
  storyAudioPaths,
  triggerStoryAudioBuild,
} from "@/lib/story-audio";
import { jsonError, jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/story/:id/audio —— 故事整段朗读回放（task-74 ①）。
 *
 * - ready   → 200 `audio/wav`（读缓存；Accept-Ranges: none）
 * - building / 无缓存 → 触发后台构建 → 202 `{status:"building"}`
 * - failed  → 500 + 可读错误；`?force=1` 后台重建 → 202
 * - 只有 1 条录音：不拼接，直接返回那条（`x-story-audio-single: 1`）
 */
export const GET = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const force = req.nextUrl.searchParams.get("force") === "1";

  const material = await getMaterial(id);
  if (!material) throw new HttpError(404, "not_found", "故事不存在");

  const { audioFile } = storyAudioPaths(id);
  const meta = readStoryAudioMeta(id);
  const state = await getStoryAudioState(id, user.id);

  if (!force && state.status === "ready" && fs.existsSync(audioFile)) {
    const data = fs.readFileSync(audioFile);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(data.byteLength),
        "accept-ranges": "none",
        "cache-control": "private, max-age=0, must-revalidate",
        "x-story-audio-cache": "hit",
        ...(meta?.single ? { "x-story-audio-single": "1" } : {}),
      },
    });
  }

  if (!force && state.status === "failed" && meta?.status === "failed" && state.attempt_count === 0) {
    // 没有录音：直接给可读提示（不反复重建）
    return jsonError(404, "no_audio", state.error ?? "还没有可回放的朗读录音");
  }
  if (!force && meta?.status === "failed" && state.attempt_count > 0) {
    return jsonError(500, "audio_failed", meta.error ?? "拼装朗读音频出错了，请稍后再试");
  }

  triggerStoryAudioBuild(id, user.id, { force });
  return jsonOk({ status: "building", attempt_count: state.attempt_count, retry_after_ms: 2000, ...(force ? { forced: true } : {}) }, 202);
});
