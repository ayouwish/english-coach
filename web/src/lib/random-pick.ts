/**
 * 随机抽句（task-31）：Fisher–Yates 部分洗牌，抽 `count` 句且**不重复**。
 *
 * ⚠️ 只能在**事件回调**里调用（点「🎲 随机」/「🔀 换一批」时），把结果存进 state。
 * 绝对不要在 render 期间调用 —— 否则 SSR 与客户端水合结果不一致（hydration mismatch）。
 *
 * 为了可测试，允许注入 `rng`（默认 Math.random）；不强依赖随机源，也不做"看起来随机"的不稳定排序。
 */
export function drawRandomSentences<T>(pool: readonly T[], count: number, rng: () => number = Math.random): T[] {
  const n = Math.max(0, Math.min(Math.floor(count), pool.length));
  if (n === 0) return [];
  // 部分 Fisher–Yates：只洗前 n 个位置，O(n) 且天然不重复
  const idx = Array.from({ length: pool.length }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (idx.length - i));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, n).map((i) => pool[i]);
}

/** 可复现的伪随机（守卫脚本用；业务代码用默认 Math.random） */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
