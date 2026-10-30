import { redirect } from "next/navigation";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { attempts, readingMaterials } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { CEFR_LEVELS, isCefrLevel } from "@/lib/levels";
import { levelSuggestion } from "@/lib/story-stats";
import { StoryClient } from "./StoryClient";

export const dynamic = "force-dynamic";

/**
 * /story —— 故事模式（task-49）：孩子用中文讲自己的故事 → 改写成适龄英文 → 自己读一遍。
 * 儿童可访问 → 页面不下发任何 IPA（零 IPA 由 check:child-ipa 覆盖）。
 */
export default async function StoryPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const defaultLevel = isCefrLevel(user.cefrLevel)
    ? user.cefrLevel
    : user.isChild
      ? "A1"
      : CEFR_LEVELS[0];

  // 难度自适应（task-50 P2）：最近 3 次"读故事"的已评分记录
  let suggestion = { suggest: null as "harder" | "easier" | null, message: null as string | null };
  try {
    const db = getDb();
    const stories = await db
      .select({ id: readingMaterials.id })
      .from(readingMaterials)
      .where(and(eq(readingMaterials.kind, "story"), eq(readingMaterials.createdBy, user.id)));
    const storyIds = stories.map((s) => s.id);
    if (storyIds.length > 0) {
      const recent = await db
        .select({ scoresJson: attempts.scoresJson })
        .from(attempts)
        .where(
          and(
            eq(attempts.userId, user.id),
            eq(attempts.status, "done"),
            isNotNull(attempts.materialId),
            inArray(attempts.materialId, storyIds),
          ),
        )
        .orderBy(desc(attempts.createdAt))
        .limit(3);
      const scores = recent.map((r) => {
        try {
          const parsed = JSON.parse(r.scoresJson ?? "{}") as { pron?: number | null };
          return typeof parsed.pron === "number" ? parsed.pron : null;
        } catch {
          return null;
        }
      });
      suggestion = levelSuggestion(scores, defaultLevel, CEFR_LEVELS);
    }
  } catch {
    /* 建议不是关键路径：失败就不提示 */
  }

  return (
    <StoryClient
      isChild={user.isChild}
      defaultLevel={defaultLevel}
      levels={[...CEFR_LEVELS]}
      levelSuggestion={suggestion}
    />
  );
}
