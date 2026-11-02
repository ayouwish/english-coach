import Link from "next/link";
import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import { StoryPrintBody, type PrintStory } from "@/components/StoryPrintBody";
import { PrintToolbar } from "@/components/PrintToolbar";

export const dynamic = "force-dynamic";

const MAX_PRINT_STORIES = 30;

/**
 * /story/print?ids=a,b,c —— 故事集打印（task-85）：封面 + 每篇另起一页。
 *
 * - 校验：ids ≤30（超出 400）；不存在的 id **忽略并提示**（家庭共享范围内不算越权，不泄漏别人内容）
 * - 选项：`zh=1` 显示中文原文、`lines=1` 加书写留白行（SSR 渲染，默认关）
 * - 打印 CSS 与单篇一致（白底黑字、隐藏导航按钮、≥14pt）；每篇 `break-before: page`
 */
export default async function StoryCollectionPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string; zh?: string; lines?: string }>;
}) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const zh = sp.zh === "1";
  const lines = sp.lines === "1";
  const rawIds = (sp.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const stories: PrintStory[] = [];
  const missing: string[] = [];
  let tooMany = rawIds.length > MAX_PRINT_STORIES;
  const ids = tooMany ? rawIds.slice(0, MAX_PRINT_STORIES) : rawIds;
  for (const id of ids) {
    const material = await getMaterial(id);
    if (!material) {
      missing.push(id);
      continue;
    }
    stories.push({
      id: material.id,
      title: material.title,
      text: material.text,
      sourceZh: material.sourceZh,
      level: material.level,
      createdAt: material.createdAt,
    });
  }
  tooMany = tooMany || rawIds.length > MAX_PRINT_STORIES;
  const qs = (nextZh: boolean, nextLines: boolean) => {
    const q = new URLSearchParams({ ids: stories.map((s) => s.id).join(",") });
    if (nextZh) q.set("zh", "1");
    if (nextLines) q.set("lines", "1");
    return `/story/print?${q.toString()}`;
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      <style>{`
        @media print {
          .no-print, header, footer { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .print-sheet { box-shadow: none !important; border: none !important; }
          .print-line { border-bottom: 1px solid #999 !important; }
          .print-origin { color: #000 !important; }
          .print-story + .print-story { break-before: page; page-break-before: always; }
          * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        }
      `}</style>

      <PrintToolbar
        printTestId="collection-print-button"
        zh={zh}
        lines={lines}
        zhHref={qs(!zh, lines)}
        linesHref={qs(zh, !lines)}
        backHref="/story"
        backLabel="← 返回故事集"
      />

      {tooMany ? (
        <p className="no-print mt-2 rounded-xl bg-[#fff3d6] p-3 text-sm text-[#7a4d00]" role="alert" data-testid="collection-too-many">
          最多一次打印 {MAX_PRINT_STORIES} 篇，已截断为前 {stories.length} 篇。
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="no-print mt-2 rounded-xl bg-[#fff3d6] p-3 text-sm text-[#7a4d00]" role="alert" data-testid="collection-missing">
          有 {missing.length} 篇故事不存在或已被删除，已跳过（不影响其它篇目打印）。
        </p>
      ) : null}

      {stories.length === 0 ? (
        <div className="ec-card mt-4 text-center" data-testid="collection-empty">
          <p className="text-base font-semibold">还没有选择要打印的故事</p>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">回到故事集，点「☑️ 选择」勾选几篇再来打印。</p>
          <Link href="/story" className="ec-btn ec-btn-primary mt-3">
            ← 去选择故事
          </Link>
        </div>
      ) : (
        <>
          {/* 封面页 */}
          <section className="print-sheet rounded-2xl border border-[#e6e8f5] bg-white p-8 text-black shadow-sm" data-testid="collection-cover">
            <h1 className="text-[24pt] font-extrabold">我的故事集</h1>
            <p className="mt-2 text-[11pt] text-[#555] print:text-black">
              共 {stories.length} 篇 · {new Date().toLocaleDateString("zh-CN")}
            </p>
            <ol className="mt-4 list-decimal pl-6 text-[13pt]">
              {stories.map((s) => (
                <li key={s.id} className="mt-1">
                  《{s.title}》
                </li>
              ))}
            </ol>
            <div className="mt-10 flex flex-wrap items-end gap-6 border-t border-[#cfd3e6] pt-4 text-[11pt]">
              <span>姓名 Name：______________</span>
              <span>日期 Date：______________</span>
            </div>
          </section>

          {stories.map((s, i) => (
            <div key={s.id} className="print-story mt-6" data-testid="collection-story">
              <StoryPrintBody story={s} zh={zh} lines={lines} pageLabel={`第 ${i + 1} / ${stories.length} 篇`} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
