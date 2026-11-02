"use client";

import Link from "next/link";

/**
 * 打印页工具栏（task-83/85）：打印按钮 + 中文/留白行开关 + 返回。
 * 打印时整条隐藏（`.no-print`），保证纸上只有正文。
 */
export function PrintToolbar({
  printTestId = "print-button",
  zh,
  lines,
  zhHref,
  linesHref,
  backHref,
  backLabel = "← 返回",
}: {
  printTestId?: string;
  zh: boolean;
  lines: boolean;
  zhHref: string;
  linesHref: string;
  backHref: string;
  backLabel?: string;
}) {
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-[#f8f9ff] p-3">
      <button type="button" data-testid={printTestId} className="ec-btn ec-btn-primary" onClick={() => window.print()}>
        🖨️ 打印 / 另存为 PDF
      </button>
      <Link
        href={zhHref}
        data-testid="print-toggle-zh"
        className={`ec-btn ${zh ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-0.5 text-xs`}
      >
        {zh ? "✓ 显示中文" : "显示中文翻译"}
      </Link>
      <Link
        href={linesHref}
        data-testid="print-toggle-lines"
        className={`ec-btn ${lines ? "ec-btn-primary" : "ec-btn-ghost"} !px-2 !py-0.5 text-xs`}
      >
        {lines ? "✓ 书写留白行" : "加书写留白行"}
      </Link>
      <Link href={backHref} className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs">
        {backLabel}
      </Link>
    </div>
  );
}
