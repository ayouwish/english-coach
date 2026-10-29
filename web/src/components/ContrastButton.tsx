"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 「对比听」（task-40）：把两个容易混的词**分开顺序播放**，而不是拼成一句合成。
 *
 * 为什么不能拼：`"think, sink"` 一次合成 + slow 语速时，Azure 会把两个相似擦音连读成一团气
 * （/θ/ 与 /s/ 糊住，实测慢速总长 2.86s），对比听恰恰要听清差别，于是反而听不出。
 *
 * 行为：
 *   1. 先播放 a（**normal** 语速）→ 停顿 gapMs（默认 550ms）→ 再播放 b；
 *   2. 播放中再点：**先停掉当前、从头开始**（不叠加）——用递增 token 让旧任务自动放弃；
 *   3. 播放期间按钮显示「▶ 对比中…」，顺序在按钮 title/aria-label 与页面文案里可读（`a → b`）；
 *   4. 失败可见（沿用现有「示范音暂时不可用」语义，不静默）。
 *
 * 注意：语速固定 normal（慢速会把擦音糊掉）；静音裁剪由 voice 侧负责，web 侧不做。
 */
export function ContrastButton({
  a,
  b,
  gapMs = 550,
  className = "",
  testid = "contrast-play",
}: {
  a: string;
  b: string;
  gapMs?: number;
  className?: string;
  testid?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef<string[]>([]);
  const runRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const urls = urlsRef;
    const timer = timerRef;
    const audio = audioRef;
    return () => {
      runRef.current += 1; // 让在途任务放弃
      if (timer.current) clearTimeout(timer.current);
      audio.current?.pause();
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, []);

  function remember(url: string) {
    urlsRef.current.push(url);
    if (urlsRef.current.length > 6) {
      const old = urlsRef.current.shift();
      if (old) URL.revokeObjectURL(old);
    }
  }

  async function fetchClip(word: string): Promise<string> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 对比听必须用 normal：slow 会把擦音糊成一团
      body: JSON.stringify({ text: word, rate: "normal" }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    remember(url);
    return url;
  }

  /** 播一段并等它播完（onended 或 error 都能解脱） */
  function playOnce(el: HTMLAudioElement, url: string): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        el.removeEventListener("ended", done);
        el.removeEventListener("error", done);
        resolve();
      };
      el.addEventListener("ended", done);
      el.addEventListener("error", done);
      el.src = url;
      void el.play().then(() => undefined).catch(done);
    });
  }

  async function play() {
    const el = audioRef.current;
    if (!el) return;
    const token = runRef.current + 1;
    runRef.current = token;
    // 播放中再点 → 先停掉当前（不叠加），从头开始
    el.pause();
    el.currentTime = 0;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBusy(true);
    setErr(null);
    try {
      const first = await fetchClip(a);
      if (token !== runRef.current) return;
      await playOnce(el, first);
      if (token !== runRef.current) return;
      // 词间停顿：~550ms，让两个音听得出边界
      await new Promise<void>((resolve) => {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          resolve();
        }, gapMs);
      });
      if (token !== runRef.current) return;
      const second = await fetchClip(b);
      if (token !== runRef.current) return;
      await playOnce(el, second);
    } catch {
      if (token === runRef.current) setErr("示范音暂时不可用");
    } finally {
      if (token === runRef.current) setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className={`ec-btn ec-btn-ghost ${className}`}
        onClick={() => void play()}
        data-testid={testid}
        data-pair={`${a}|${b}`}
        data-rate="normal"
        aria-label={`对比听：先播放 ${a}，再播放 ${b}`}
        title={`先 ${a} → 再 ${b}（正常语速）`}
      >
        {busy ? "▶ 对比中…" : "🔀 对比听"}
      </button>
      <span className="text-[10px] text-[var(--ec-muted)]">
        {a} → {b}
      </span>
      {err ? (
        <span className="text-xs text-[#b45309]" data-testid="contrast-error">
          {err}
        </span>
      ) : null}
      <audio ref={audioRef} className="hidden" />
    </span>
  );
}
