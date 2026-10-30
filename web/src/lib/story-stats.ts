/**
 * 故事模式 P1/P2 的纯逻辑（task-50）—— 无 React、无 DOM，可单测。
 *
 *  - 故事集按自然日分组（今天/昨天/更早）
 *  - 「已连续记录 N 天」：按 created_at 的自然日去重，从今天（或昨天）往前数连续天数
 *  - 难度自适应提示：最近 3 次朗读均分 ≥85 → 建议更难；<60 → 建议更简单（只提示不强制）
 *  - 鼓励文案：不出现"断了"这类压力措辞
 */

export interface DatedItem {
  created_at: string;
}

export interface StoryGroups<T extends DatedItem> {
  today: T[];
  yesterday: T[];
  earlier: T[];
}

/** 本地自然日的 key（YYYY-MM-DD），避免用 UTC 把"昨天/今天"算错 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function todayKey(now: Date = new Date()): string {
  // 本地自然日（避免用 UTC 把"今天/昨天"算错）
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shiftDay(key: string, deltaDays: number): string {
  // 用 UTC 做纯日期加减：避免本地时区把 toISOString 的日期"退一天"
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

/** 按自然日分组：今天 / 昨天 / 更早（组内保持传入顺序） */
export function groupStoriesByDay<T extends DatedItem>(items: readonly T[], now: Date = new Date()): StoryGroups<T> {
  const today = todayKey(now);
  const yesterday = shiftDay(today, -1);
  const groups: StoryGroups<T> = { today: [], yesterday: [], earlier: [] };
  for (const item of items) {
    const key = dayKey(item.created_at);
    if (key === today) groups.today.push(item);
    else if (key === yesterday) groups.yesterday.push(item);
    else groups.earlier.push(item);
  }
  return groups;
}

/**
 * 连续记录天数：从"今天"往前数；若今天还没记录，则从"昨天"开始数（昨天有记录也算连着）。
 * 断档即停（不出现"断了"的措辞，只在 UI 上显示已有的天数）。
 */
export function consecutiveDays(dates: readonly string[], now: Date = new Date()): number {
  const keys = new Set(dates.map((d) => dayKey(d)));
  if (keys.size === 0) return 0;
  let cursor = todayKey(now);
  if (!keys.has(cursor)) {
    cursor = shiftDay(cursor, -1);
    if (!keys.has(cursor)) return 0;
  }
  let n = 0;
  while (keys.has(cursor)) {
    n += 1;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/** 鼓励文案（不施压、不出现"断/缺"等负面词） */
export function streakMessage(days: number): string {
  if (days <= 0) return "今天讲一个故事，就开始你的故事本啦";
  if (days === 1) return "今天写了第 1 个故事，很棒的开头";
  return `已经连续讲故事 ${days} 天，这些都会留在你的故事本里`;
}

export interface LevelSuggestion {
  suggest: "harder" | "easier" | null;
  message: string | null;
}

/**
 * 难度自适应（只提示，不强制）：
 *  - 最近 3 次平均分 ≥ 85 → 建议更难（已在最高级别则不再提示）
 *  - 平均分 < 60 → 建议更简单（已在最低级别则不再提示）
 */
export function levelSuggestion(recentScores: readonly (number | null)[], currentLevel: string, levels: readonly string[]): LevelSuggestion {
  const scores = recentScores.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (scores.length === 0) return { suggest: null, message: null };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const idx = levels.indexOf(currentLevel);
  const last = levels.length - 1;
  if (avg >= 85 && idx < last && idx >= 0) {
    return {
      suggest: "harder",
      message: `最近几次读得很稳（平均 ${Math.round(avg)} 分），可以试试更难的 ${levels[idx + 1]}`,
    };
  }
  if (avg < 60 && idx > 0) {
    return {
      suggest: "easier",
      message: `最近几次有点吃力（平均 ${Math.round(avg)} 分），要不要换成 ${levels[idx - 1]}？`,
    };
  }
  return { suggest: null, message: null };
}
