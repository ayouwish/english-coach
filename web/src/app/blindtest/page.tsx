import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getBlindTestForPage } from "@/lib/blind-test";
import { BlindTestClient } from "./BlindTestClient";

export const dynamic = "force-dynamic";

/**
 * /blindtest —— 盲测进行页。
 * 契约 §13.3 第 1 条：**全程不显示任何分数**。
 * 因此这个页面（以及它的 props / RSC 负载）里没有任何历史分数、没有 avg_* 字段。
 */
export default async function BlindTestPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getBlindTestForPage(user);

  return (
    <BlindTestClient
      isChild={user.isChild}
      displayName={user.displayName}
      data={data}
    />
  );
}
