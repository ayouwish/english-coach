"use client";

import { useEffect, useRef, useState } from "react";
import { buildEncouragement, type Encouragement } from "@/lib/encouragement";

/** 中文鼓励音色 / 英文鼓励音色（显式传给 /api/tts；voice 侧按音色推导 SSML 的 xml:lang） */
export const ZH_VOICE = "zh-CN-XiaoxiaoNeural";
export const EN_VOICE = "en-US-JennyNeural";
const GAP_MS = 300;

/** 最近选过的 3 条（避免连续重复）。只在客户端更新（本组件用于"读完之后"的客户端界面）。 */
const RECENT_PICKS: string[] = [];
function rememberPick(zh: string) {
  RECENT_PICKS.push(zh);
  while (RECENT_PICKS.length > 3) RECENT_PICKS.shift();
}

export interface EncouragementBoxProps {
  /** 确定性种子（同一 attempt/同一轮结果 → 文案固定，避免水合不一致） */
  attemptId: string;
  pron: number | null;
  completeness?: number | null;
  prevPron?: number | null;
  noSpeech?: boolean;
  words?: { word: string; score: number | null }[] | null;
  phonemes?: { phoneme: string; score: number | null }[] | null;
  isChild?: boolean;
  /** 挂载后尝试自动播放（评分是异步完成的，可能不在用户手势里 → 被拦就降级为按钮） */
  autoPlay?: boolean;
}

/**
 * 读完之后的分级鼓励（task-45）：按表现选文案（成长型、永不否定、确定性挑选），
 * 显示中英两句，并尝试顺序播放「中文 → 300ms → 英文」。
 *
 * 失败**不静默**：
 *   - 自动播放被浏览器拦住 → 显示「点「听鼓励」就能听语音」（按钮始终存在）
 *   - 语音不可用 → 角落显示「语音暂时不可用」（文字照常展示，不打断练习）
 */
export function EncouragementBox({
  attemptId,
  pron,
  completeness = null,
  prevPron = null,
  noSpeech = false,
  words = null,
  phonemes = null,
  isChild = false,
  autoPlay = true,
}: EncouragementBoxProps) {
  // 纯函数 + 确定性哈希：同一个 attemptId 每次得到同一条文案（无 render 期 Math.random）
  const [enc] = useState<Encouragement>(() =>
    buildEncouragement({
      attemptId,
      pron,
      completeness,
      prevPron,
      noSpeech,
      words,
      phonemes,
      isChild,
      recentZh: [...RECENT_PICKS],
    }),
  );
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef<string[]>([]);
  const runRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    rememberPick(enc.zh);
  }, [enc.zh]);

  useEffect(() => {
    const urls = urlsRef;
    const timer = timerRef;
    const audio = audioRef;
    return () => {
      runRef.current += 1;
      if (timer.current) clearTimeout(timer.current);
      audio.current?.pause();
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, []);

  function rememberUrl(url: string) {
    urlsRef.current.push(url);
    if (urlsRef.current.length > 6) {
      const old = urlsRef.current.shift();
      if (old) URL.revokeObjectURL(old);
    }
  }

  async function fetchClip(text: string, voice: string): Promise<string> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 显式传 voice；rate 固定 normal
      body: JSON.stringify({ text, voice, rate: "normal" }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    rememberUrl(url);
    return url;
  }

  function playOnce(el: HTMLAudioElement, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        el.removeEventListener("ended", done);
        el.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        el.removeEventListener("ended", done);
        el.removeEventListener("error", onError);
        reject(new Error("audio element error"));
      };
      el.addEventListener("ended", done);
      el.addEventListener("error", onError);
      el.src = url;
      void el
        .play()
        .then(() => undefined)
        .catch((err: unknown) => {
          el.removeEventListener("ended", done);
          el.removeEventListener("error", onError);
          const name = (err as { name?: string })?.name;
          if (name === "NotAllowedError") setBlocked(true);
          reject(err);
        });
    });
  }

  async function play() {
    const el = audioRef.current;
    if (!el) return;
    const token = runRef.current + 1;
    runRef.current = token;
    el.pause();
    el.currentTime = 0;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(true);
    setAudioError(null);
    setBlocked(false);
    try {
      // ① 中文
      const zhUrl = await fetchClip(enc.fullZh, ZH_VOICE);
      if (token !== runRef.current) return;
      await playOnce(el, zhUrl);
      if (token !== runRef.current) return;
      // ② 停 300ms
      await new Promise<void>((resolve) => {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          resolve();
        }, GAP_MS);
      });
      if (token !== runRef.current) return;
      // ③ 英文
      const enUrl = await fetchClip(enc.en, EN_VOICE);
      if (token !== runRef.current) return;
      await playOnce(el, enUrl);
    } catch (err) {
      if (token === runRef.current) {
        const name = (err as { name?: string })?.name;
        if (name === "NotAllowedError") setBlocked(true);
        else setAudioError("语音暂时不可用");
      }
    } finally {
      if (token === runRef.current) setPlaying(false);
    }
  }

  // 挂载后尝试自动播（不在手势里 → 可能被拦；被拦就由 blocked 提示引导点按钮）
  useEffect(() => {
    if (!autoPlay) return;
    const t = setTimeout(() => void play(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时尝试一次
  }, []);

  return (
    <div className="mt-3 rounded-xl bg-[#eef8ff] p-3" data-testid="encouragement" data-tier={enc.tier}>
      <p
        className={isChild ? "text-xl font-extrabold leading-snug" : "text-base font-extrabold leading-snug"}
        data-testid="encouragement-zh"
      >
        {enc.fullZh}
      </p>
      <p className="mt-1 text-sm" data-testid="encouragement-en">
        {enc.en}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="ec-btn ec-btn-primary !px-3 !py-1 text-sm"
          data-testid="encouragement-play"
          aria-label="播放鼓励语音（中文，然后英文）"
          disabled={playing}
          onClick={() => void play()}
        >
          {playing ? "🔊 播放中…" : "🔊 听鼓励"}
        </button>
        {blocked && !playing ? (
          <span className="text-xs text-[#7a4d00]" data-testid="encouragement-blocked">
            浏览器没让自动播放：点「听鼓励」就能听。
          </span>
        ) : null}
        {audioError ? (
          <span className="text-xs text-[#b45309]" data-testid="encouragement-error">
            {audioError}（文字已经显示，可以跟着念）
          </span>
        ) : null}
      </div>
      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
