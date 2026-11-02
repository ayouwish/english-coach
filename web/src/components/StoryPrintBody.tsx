import { splitSentences } from "@/lib/sentence-split";

export interface PrintStory {
  id: string;
  title: string;
  text: string;
  sourceZh: string | null;
  level: string | null;
  createdAt: string;
}

/**
 * 打印正文块（task-83/85 共用）：标题 + 级别 + 日期 + 编号英文句子（可选中文原文 / 书写留白行）。
 * 单篇打印页与故事集打印页共用，避免两套样式漂移。
 */
export function StoryPrintBody({
  story,
  zh,
  lines,
  pageLabel,
}: {
  story: PrintStory;
  zh: boolean;
  lines: boolean;
  /** 合集里显示「第 X / N 篇」 */
  pageLabel?: string;
}) {
  const sentences = splitSentences(story.text);
  return (
    <article className="print-sheet rounded-2xl border border-[#e6e8f5] bg-white p-6 text-[15pt] leading-[1.9] text-black shadow-sm print:text-[14pt] print:leading-[2]">
      <header className="border-b border-[#cfd3e6] pb-3">
        <h1 className="text-[20pt] font-extrabold leading-snug">{story.title}</h1>
        <p className="mt-1 text-[10pt] text-[#555] print:text-black">
          等级 {story.level ?? "—"} · {sentences.length} 句 · {new Date(story.createdAt).toLocaleDateString("zh-CN")}
          {pageLabel ? ` · ${pageLabel}` : ""}
        </p>
      </header>

      {zh && story.sourceZh ? (
        <section className="print-origin mt-4 rounded-xl bg-[#f8f9ff] p-3 text-[11pt] leading-relaxed text-[#333]" data-testid="print-source-zh">
          <h2 className="text-[12pt] font-bold">中文原文（我讲的）</h2>
          <p className="mt-1 whitespace-pre-wrap">{story.sourceZh}</p>
        </section>
      ) : null}

      <section className="mt-5" data-testid="print-sentences">
        <h2 className="text-[13pt] font-bold">Read aloud · 朗读练习</h2>
        <ol className="mt-2 list-decimal space-y-3 pl-6">
          {sentences.map((s, i) => (
            <li key={i} data-testid="print-sentence" className="pl-1">
              <span>{s}</span>
              {lines ? <div className="print-line mt-2 h-6 border-b border-dashed border-[#bbb]" aria-hidden /> : null}
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-8 flex flex-wrap items-end gap-6 border-t border-[#cfd3e6] pt-4 text-[10pt] print:text-black">
        <span>名字 Name：______________</span>
        <span>日期 Date：______________</span>
        {pageLabel ? <span className="ml-auto font-semibold">{pageLabel}</span> : null}
        <span className={pageLabel ? "text-[#777]" : "ml-auto text-[#777]"}>英语教练 · 我的故事</span>
      </footer>
    </article>
  );
}
