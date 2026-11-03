import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import { StoryPrintBody } from "@/components/StoryPrintBody";
import { StoryPrintCard } from "@/components/StoryPrintCard";
import { PrintToolbar } from "@/components/PrintToolbar";

export const dynamic = "force-dynamic";

/**
 * /story/[id]/print —— 可打印的故事练习纸（task-83）+ **A5 卡片版式**（task-89）。
 *
 * - `?layout=card` → A5 卡片（148×210mm、虚线裁切框、适合剪下/贴墙）；默认仍是整页练习纸
 * - 英文句子编号；可选中文原文（`?zh=1`）与书写留白行（`?lines=1`）
 * - 页脚手写栏（名字/日期）；`window.print()` 可直接打印或另存 PDF
 * - 版式切换在工具栏（整页练习纸 / A5 卡片），非打印时可见
 */
export default async function StoryPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ zh?: string; lines?: string; layout?: string }>;
}) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  const zh = sp.zh === "1";
  const lines = sp.lines === "1";
  const isCard = sp.layout === "card";
  const material = await getMaterial(id);
  if (!material) notFound();

  const qs = (next: { zh?: boolean; lines?: boolean; card?: boolean }) => {
    const q = new URLSearchParams();
    const nz = next.zh ?? zh;
    const nl = next.lines ?? lines;
    const nc = next.card ?? isCard;
    if (nz) q.set("zh", "1");
    if (nl) q.set("lines", "1");
    if (nc) q.set("layout", "card");
    const tail = q.toString();
    return `/story/${material.id}/print${tail ? `?${tail}` : ""}`;
  };
  const story = {
    id: material.id,
    title: material.title,
    text: material.text,
    sourceZh: material.sourceZh,
    level: material.level,
    createdAt: material.createdAt,
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      {/* 打印专用样式：白底黑字、隐藏导航/工具栏；A4 页面 + 卡片居中且不跨页 */}
      <style>{`
        @page { size: A4; margin: 10mm; }
        @media print {
          .no-print, header, footer { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .print-sheet { box-shadow: none !important; border: none !important; }
          .print-card {
            box-shadow: none !important;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
            margin: 0 auto !important;
          }
          .print-line { border-bottom: 1px solid #999 !important; }
          .print-origin { color: #000 !important; }
          * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        }
      `}</style>

      {/* 版式切换（task-89）：整页练习纸 / A5 卡片，带选中态 */}
      <div className="no-print mb-2 flex flex-wrap items-center gap-2" data-testid="print-layout-switch">
        <span className="text-xs font-semibold text-[var(--ec-muted)]">版式：</span>
        <Link
          href={qs({ card: false })}
          data-testid="print-layout-full"
          aria-pressed={!isCard}
          className={`ec-btn ${!isCard ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-0.5 text-xs`}
        >
          📄 整页练习纸
        </Link>
        <Link
          href={qs({ card: true })}
          data-testid="print-layout-card"
          aria-pressed={isCard}
          className={`ec-btn ${isCard ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-0.5 text-xs`}
        >
          🗂️ A5 卡片
        </Link>
      </div>

      <PrintToolbar
        zh={zh}
        lines={lines}
        zhHref={qs({ zh: !zh })}
        linesHref={qs({ lines: !lines })}
        backHref={`/story/${material.id}`}
        backLabel="← 返回故事"
      />

      {isCard ? (
        <div className="print-card-wrap flex justify-center" data-testid="print-card-wrap">
          <StoryPrintCard story={story} zh={zh} lines={lines} />
        </div>
      ) : (
        <div data-testid="print-full">
          <StoryPrintBody story={story} zh={zh} lines={lines} />
        </div>
      )}

      <p className="no-print mt-4 text-center text-xs text-[var(--ec-muted)]">
        <Link href={`/story/${material.id}`} className="underline">
          返回故事详情
        </Link>
        {isCard ? <span className="ml-2">（卡片：沿虚线剪下即可）</span> : null}
      </p>
    </div>
  );
}
