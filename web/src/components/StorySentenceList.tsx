import { splitSentences } from "@/lib/sentence-split";

/**
 * 编号英文句子列表（task-83/89 共用）：整页练习纸与 A5 卡片都用它渲染正文，
 * 保证"句子渲染逻辑"只有一份；**版式由外层决定**（字号/间距/是否书写线）。
 */
export function StorySentenceList({
  text,
  lines,
  compact = false,
}: {
  text: string;
  lines: boolean;
  /** 卡片版式：更紧凑（字号由外层控制） */
  compact?: boolean;
}) {
  const sentences = splitSentences(text);
  return (
    <ol className={`list-decimal pl-6 ${compact ? "space-y-2" : "mt-2 space-y-3"}`} data-testid="print-sentences">
      {sentences.map((s, i) => (
        <li key={i} data-testid="print-sentence" className="print-sentence pl-1">
          <span>{s}</span>
          {lines ? (
            <div
              className={`print-line border-b border-dashed border-[#bbb] ${compact ? "mt-1 h-5" : "mt-2 h-6"}`}
              aria-hidden
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** 句子数量（给页眉"共 N 句"用） */
export function sentenceCountOf(text: string): number {
  return splitSentences(text).length;
}
