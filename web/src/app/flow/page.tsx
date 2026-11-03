import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { sentences } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getCapabilities } from "@/lib/voice";
import { FlowClient } from "./FlowClient";
import { getPrefs, effectiveShowWordIpa } from "@/lib/prefs";

export const dynamic = "force-dynamic";

/**
 * /flow —— 连读模式（task-24）：逐句连读、不等待评分，后台排队算、结果陆续出现。
 * 儿童可访问 → 页面只下发音频文本/级别，**不下发 focus_phonemes**（零 IPA）。
 */
export default async function FlowPage({
  searchParams,
}: {
  searchParams?: Promise<{ material?: string }>;
}) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const rows = await getDb()
    .select()
    .from(sentences)
    .orderBy(asc(sentences.sortOrder));
  const caps = await getCapabilities();
  const corpus = rows
    .filter((r) => r.source !== "flow-custom")
    .map((r) => ({ id: r.id, text: r.text, level: r.level }));

  const materialParam = (await searchParams)?.material ?? null;
  return (
    <FlowClient
      // task-93：参数变化（?material=x → /flow）时强制重挂载，避免 mode/items/phase 残留
      // 无参数进入 = 全新 corpus 状态；手动切 tab 不受影响（同一实例内切换）
      key={materialParam ?? "corpus"}
      isChild={user.isChild}
      showWordIpa={effectiveShowWordIpa(await getPrefs(user.id, user.isChild))}
      userLevel={user.cefrLevel}
      corpus={corpus}
      voiceReachable={caps.reachable}
      ocrAvailable={caps.capabilities.ocr === true}
      heicAvailable={caps.capabilities.heic === true}
      initialMaterialId={materialParam}
    />
  );
}
