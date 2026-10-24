import { NextRequest } from "next/server";
import { ensureBootstrap } from "@/db";
import { requireUser } from "@/lib/auth";
import { listBlindTests, startBlindTest } from "@/lib/blind-test";
import { childSafeDeep } from "@/lib/child-safe";
import { HttpError } from "@/lib/auth";
import { jsonOk, route } from "@/lib/http";
import { assertWithinDailyLimit } from "@/lib/limits";

export const dynamic = "force-dynamic";

/**
 * GET /api/blind-tests —— 历史 + 周环比趋势（契约 §13.4）。
 * 家长可带 ?user_id=<孩子> 查看孩子的周报；儿童只能看自己的。
 */
export const GET = route(async (req: NextRequest) => {
  await ensureBootstrap();
  const user = await requireUser();
  const requested = req.nextUrl.searchParams.get("user_id");
  let targetId = user.id;
  if (requested && requested !== user.id) {
    if (user.role !== "parent") {
      throw new HttpError(403, "forbidden", "只能查看自己的盲测周报");
    }
    targetId = requested;
  }
  const data = await listBlindTests(targetId);
  // 防御性：盲测数据本身只有数字/句子 id，儿童路径仍整体兜底一遍
  return jsonOk(user.isChild ? childSafeDeep(data, "blind-tests.get") : data);
});

/** POST /api/blind-tests —— 开始一次盲测（已有进行中的则直接返回它）。 */
export const POST = route(async () => {
  await ensureBootstrap();
  const user = await requireUser();
  await assertWithinDailyLimit(user);
  const started = await startBlindTest(user);
  return jsonOk(
    {
      blind_test_id: started.test.id,
      sentence_ids: started.sentence_ids,
      total: started.total,
      resumed: started.resumed,
      started_at: started.test.started_at,
    },
    started.resumed ? 200 : 201,
  );
});
