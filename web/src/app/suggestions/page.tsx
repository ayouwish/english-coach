import { forbidden, redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { listSuggestions } from "@/lib/suggestions";
import { SuggestionsClient } from "./SuggestionsClient";

export const dynamic = "force-dynamic";

/**
 * /suggestions —— 家长查看/处理建议（task-23 C3）。
 * 儿童访问由服务端 forbidden() 返回 HTTP 403（不只是隐藏入口）。
 */
export default async function SuggestionsPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "parent") forbidden();

  const data = await listSuggestions({ limit: 200, offset: 0 });

  return (
    <div className="flex flex-col gap-5">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">💡 建议箱</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          家里人在使用中留下的建议都汇总在这里。可以标记状态，也可以导出 Markdown 直接交给开发者/AI 继续优化。
        </p>
      </section>
      <SuggestionsClient initial={data} />
    </div>
  );
}
