import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { HttpError, requireUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import { getStoryAudioState } from "@/lib/story-audio";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/story/:id/audio/status —— 只读状态（不触发构建），供页面轮询。 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await ensureBootstrap();
  const user = await requireUser();
  const { id } = await ctx.params;
  const material = await getMaterial(id);
  if (!material) throw new HttpError(404, "not_found", "故事不存在");
  return jsonOk(await getStoryAudioState(id, user.id));
});
