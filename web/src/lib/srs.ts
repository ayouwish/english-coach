/** SM-2 简化版（again / hard / good / easy），仅依赖 srs_cards 的 ease/interval_days/reps/lapses。 */

export type Grade = "again" | "hard" | "good" | "easy";

export interface SrsState {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
}

export interface SrsNext extends SrsState {
  dueAt: Date;
  lastGrade: Grade;
}

const MIN_EASE = 1.3;
const MAX_EASE = 2.8;

export function schedule(state: SrsState, grade: Grade, now = new Date()): SrsNext {
  let { ease, intervalDays, reps, lapses } = state;
  ease = Number.isFinite(ease) && ease > 0 ? ease : 2.5;
  intervalDays = Number.isFinite(intervalDays) && intervalDays >= 0 ? intervalDays : 0;
  reps = Number.isFinite(reps) && reps >= 0 ? reps : 0;
  lapses = Number.isFinite(lapses) && lapses >= 0 ? lapses : 0;

  switch (grade) {
    case "again": {
      lapses += 1;
      reps = 0;
      ease = clamp(ease - 0.2, MIN_EASE, MAX_EASE);
      intervalDays = 0;
      // 10 分钟后再来一次
      return { ease, intervalDays, reps, lapses, dueAt: new Date(now.getTime() + 10 * 60_000), lastGrade: grade };
    }
    case "hard": {
      reps += 1;
      ease = clamp(ease - 0.15, MIN_EASE, MAX_EASE);
      intervalDays = intervalDays <= 0 ? 1 : Math.max(1, Math.round(intervalDays * 1.2));
      break;
    }
    case "good": {
      reps += 1;
      intervalDays = intervalDays <= 0 ? 1 : Math.max(1, Math.round(intervalDays * ease));
      break;
    }
    case "easy": {
      reps += 1;
      ease = clamp(ease + 0.15, MIN_EASE, MAX_EASE);
      intervalDays = intervalDays <= 0 ? 3 : Math.max(3, Math.round(intervalDays * ease * 1.3));
      break;
    }
  }
  return {
    ease,
    intervalDays,
    reps,
    lapses,
    dueAt: new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000),
    lastGrade: grade,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const GRADES: Grade[] = ["again", "hard", "good", "easy"];

export function gradeLabelZh(grade: Grade): string {
  switch (grade) {
    case "again":
      return "再来一次";
    case "hard":
      return "有点难";
    case "good":
      return "记住了";
    case "easy":
      return "太简单";
  }
}
