import { StorySentenceList, sentenceCountOf } from "./StorySentenceList";
import type { PrintStory } from "./StoryPrintBody";

/**
 * A5 故事卡（task-89）：148×210mm、虚线裁切框、白底黑字，适合剪下来/贴墙/夹绘本。
 *
 * 版式与整页练习纸**独立**（不共用外层样式），只复用 `StorySentenceList` 的句子渲染。
 * `zh=1` 的处理（选择说明）：卡片空间有限，中文原文放在句子列表下方作为**小字段落区块**，
 * 而不是逐句对照（逐句会让卡片溢出到第二页，破坏"一张卡"的目标）。
 */
export function StoryPrintCard({ story, zh, lines }: { story: PrintStory; zh: boolean; lines: boolean }) {
  const count = sentenceCountOf(story.text);
  return (
    <article
      className="print-card relative mx-auto bg-white text-black"
      data-testid="print-card"
      style={{
        width: "148mm",
        minHeight: "210mm",
        padding: "10mm",
        border: "1.5px dashed #666",
        borderRadius: "4mm",
        breakInside: "avoid",
        pageBreakInside: "avoid",
        boxSizing: "border-box",
      }}
    >
      <header className="border-b border-[#999] pb-2">
        <h1 className="text-[17pt] font-extrabold leading-snug" data-testid="print-card-title">
          {story.title}
        </h1>
        <p className="mt-1 text-[9pt] text-[#555] print:text-black">
          等级 {story.level ?? "—"} · {count} 句 · {new Date(story.createdAt).toLocaleDateString("zh-CN")}
        </p>
      </header>

      <section className="mt-3" data-testid="print-card-sentences">
        <ol className="text-[12pt] leading-[1.75]">
          <StorySentenceList text={story.text} lines={lines} compact />
        </ol>
      </section>

      {zh && story.sourceZh ? (
        <section className="mt-3 border-t border-dashed border-[#bbb] pt-2" data-testid="print-card-source-zh">
          <p className="text-[8.5pt] leading-relaxed text-[#444] print:text-black">中文原文（我讲的）：{story.sourceZh}</p>
        </section>
      ) : null}

      <footer className="mt-4 flex flex-wrap items-end gap-3 border-t border-[#999] pt-2 text-[9pt] print:text-black">
        <span>姓名 Name：__________</span>
        <span>日期 Date：__________</span>
        <span className="ml-auto text-[8pt] text-[#777] print:text-black">英语教练 · 我的故事卡</span>
      </footer>
    </article>
  );
}
