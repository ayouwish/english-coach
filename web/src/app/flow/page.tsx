import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { ensureBootstrap, getDb } from "@/db";
import { sentences } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getCapabilities } from "@/lib/voice";
import { FlowClient } from "./FlowClient";

export const dynamic = "force-dynamic";

/**
 * /flow —— 连读模式（task-24）：逐句连读、不等待评分，后台排队算、结果陆续出现。
 * 儿童可访问 → 页面只下发音频文本/级别，**不下发 focus_phonemes**（零 IPA）。
 */
export default async function FlowPage() {
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

  return (
    <FlowClient
      isChild={user.isChild}
      userLevel={user.cefrLevel}
      corpus={corpus}
      voiceReachable={caps.reachable}
      ocrAvailable={caps.capabilities.ocr === true}
      heicAvailable={caps.capabilities.heic === true}
    />
  );
}
