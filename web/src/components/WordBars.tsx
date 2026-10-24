import { encodeWordRows, wordBarAriaLabel, type RawWordScore, type WordRow } from "@/lib/word-encoding";

/**
 * 词级反馈：**长度编码**（task-14 C）。
 *
 * - 主编码 = 条长（= 分数）；颜色全部同一中性色，不承担任何信息 → 色盲友好
 * - 问题词（<60）用 **⚠️ + 置顶排序**（分数升序）突出，另加一条 60 分参考刻度线
 * - 完整列表按句子原文顺序放在下面；"最差的那个词"靠排序第一条 + 文字标记 + 数字三重冗余
 */
export function WordBars({
  words,
  isChild,
  showAll = true,
}: {
  words: RawWordScore[];
  isChild: boolean;
  showAll?: boolean;
}) {
  const { all, problem, worst } = encodeWordRows(words);

  if (all.length === 0) {
    return <p className="text-sm text-[var(--ec-muted)]">没有拿到逐词分数。</p>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="word-bars">
      <section data-testid="problem-words">
        <h4 className="text-sm font-bold">
          ⚠️ {isChild ? "需要多练几遍的词" : "需要练的词"}
          <span className="ml-2 font-normal text-[var(--ec-muted)]">
            低于 60 分 · 按分数从低到高（最难的排最前）
          </span>
        </h4>
        {problem.length === 0 ? (
          <p className="mt-1 text-sm text-[var(--ec-muted)]" data-testid="no-problem-words">
            这次没有低于 60 分的词，保持就好 👍
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {problem.map((row) => (
              <WordBarRow key={`p-${row.index}-${row.word}`} row={row} isChild={isChild} markWorst={row === problem[0]} />
            ))}
          </ul>
        )}
      </section>

      {showAll ? (
        <section data-testid="all-words">
          <h4 className="text-sm font-bold">
            {isChild ? "每个词读得怎么样" : "逐词得分（句子顺序）"}
            <span className="ml-2 font-normal text-[var(--ec-muted)]">条越长越好</span>
          </h4>
          <ul className="mt-1 flex flex-col gap-1">
            {all.map((row) => (
              <WordBarRow
                key={`a-${row.index}-${row.word}`}
                row={row}
                isChild={isChild}
                markWorst={worst !== null && row.index === worst.index && row.problem}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function WordBarRow({
  row,
  isChild,
  markWorst,
}: {
  row: WordRow;
  isChild: boolean;
  markWorst: boolean;
}) {
  return (
    <li
      className="flex items-center gap-2 text-sm"
      data-testid="word-row"
      data-word={row.word}
      data-score={row.score === null ? "null" : String(Math.round(row.score))}
      data-problem={row.problem ? "1" : "0"}
      data-worst={markWorst ? "1" : "0"}
    >
      <span className={`w-24 shrink-0 truncate ${row.problem ? "font-bold" : "font-medium"}`} title={row.word}>
        {row.problem ? "⚠️ " : ""}
        {row.word}
      </span>
      {/* 条长 = 分数（唯一主编码）；颜色对所有行相同，不编码任何信息 */}
      <span
        className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-[#eef0f8]"
        role="img"
        aria-label={wordBarAriaLabel(row)}
      >
        <span className="absolute left-[60%] top-[-2px] z-10 h-[7px] w-px bg-[#c7c9f2]" aria-hidden="true" />
        <span
          className="block h-full rounded-full bg-[#8e93e8]"
          style={{ width: `${row.barPct}%` }}
          data-testid="word-bar"
        />
      </span>
      <span className="w-10 shrink-0 text-right font-semibold tabular-nums">
        {row.score === null ? "—" : Math.round(row.score)}
      </span>
      {markWorst ? (
        <span className="shrink-0 rounded bg-[#fff3d6] px-1.5 py-0.5 text-xs font-semibold text-[#7a4d00]">
          {isChild ? "最需要练" : "最需要练"}
        </span>
      ) : null}
    </li>
  );
}
