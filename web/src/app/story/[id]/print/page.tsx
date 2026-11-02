import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getMaterial } from "@/lib/materials";
import { StoryPrintBody } from "@/components/StoryPrintBody";
import { PrintToolbar } from "@/components/PrintToolbar";

export const dynamic = "force-dynamic";

/**
 * /story/[id]/print —— 可打印的故事练习纸（task-83）。
 *
 * - 独立版式：无导航（打印时 `.no-print` 隐藏工具栏）；纯白底、大字号、宽松行距
 * - 英文句子编号；可选中文原文（`?zh=1`）与书写留白行（`?lines=1`）
 * - 页脚手写栏（名字/日期）；`window.print()` 可直接打印或另存 PDF
 */
export default async function StoryPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ zh?: string; lines?: string }>;
}) {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  const zh = sp.zh === "1";
  const lines = sp.lines === "1";
  const material = await getMaterial(id);
  if (!material) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      {/* 打印专用样式：白底黑字、大字号、隐藏导航与工具栏 */}
      <style>{`
        @media print {
          .no-print, header, footer { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .print-sheet { box-shadow: none !important; border: none !important; }
          .print-line { border-bottom: 1px solid #999 !important; }
          .print-origin { color: #000 !important; }
          * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        }
      `}</style>
      <PrintToolbar
        zh={zh}
        lines={lines}
        zhHref={`/story/${material.id}/print${zh ? "" : "?zh=1"}${lines ? `${zh ? "&" : "?"}lines=1` : ""}`}
        linesHref={`/story/${material.id}/print${lines ? "" : "?lines=1"}${zh ? `${lines ? "&" : "?"}zh=1` : ""}`}
        backHref={`/story/${material.id}`}
        backLabel="← 返回故事"
      />

      <StoryPrintBody
        story={{
          id: material.id,
          title: material.title,
          text: material.text,
          sourceZh: material.sourceZh,
          level: material.level,
          createdAt: material.createdAt,
        }}
        zh={zh}
        lines={lines}
      />

      <p className="no-print mt-4 text-center text-xs text-[var(--ec-muted)]">
        <Link href={`/story/${material.id}`} className="underline">
          返回故事详情
        </Link>
      </p>
    </div>
  );
}
