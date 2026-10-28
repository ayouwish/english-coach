import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { getAttemptStatuses } from "@/lib/async-scoring";
import { wordsFromPhonemeScores } from "@/lib/attempt-view";
import { childSafeDeep } from "@/lib/child-safe";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/attempts/status?ids=a,b,c —— 连读模式前端轮询用（task-24）。
 * 返回每条的状态与（完成时的）完整结果；儿童载荷整体剥离 IPA。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const raw = req.nextUrl.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 50);
  if (ids.length === 0) return jsonOk({ items: [] });

  const rows = await getAttemptStatuses(user.id, ids);
  const payload = {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      scored_at: r.scored_at,
      result:
        r.status === "done"
          ? {
              scores: r.scores,
              // attempts 没有 words_json：从 phoneme_scores 还原逐词得分
              words: wordsFromPhonemeScores(r.id),
              issues: r.issues ?? [],
              intonation: r.intonation,
              feedback: r.feedback,
              recognized_text: r.recognized_text,
            }
          : null,
    })),
  };
  return jsonOk(user.isChild ? childSafeDeep(payload, "attempts.status") : payload);
});
