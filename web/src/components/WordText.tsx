"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Token {
  text: string;
  isWord: boolean;
}

interface IpaResult {
  word: string;
  ipa: string | null;
  variants?: string[];
  syllables?: number | null;
  ipa_disabled?: boolean;
  error?: { message?: string };
}

/** 按"单词 / 非单词"切分，**保留标点与空格**（渲染后与原句完全一致）。 */
export function tokenizeWords(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), isWord: false });
    tokens.push({ text: match[0], isWord: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), isWord: false });
  return tokens;
}

/** 全应用同一时刻只开一个音标浮层 */
let activeCloser: (() => void) | null = null;

/**
 * 可点单词正文（task-87）：点一下显示音标 + 听发音。
 *
 * - 保留标点空格；单词是 `<button>`（键盘可聚焦/Enter 可开）
 * - 浮层：移动端底部 sheet；桌面靠近单词（自动避让视口）
 * - 儿童/关闭开关 → 只显示 🔊（不渲染 IPA）
 * - 未有音标 → 「暂无音标」+ 🔊 仍可用；关闭：再点同词 / 点空白 / Esc / 滚屏
 */
export function WordText({
  text,
  showIpa = true,
  as: Tag = "span",
  className = "",
}: {
  text: string;
  /** 是否渲染 IPA（儿童默认 false）；false 时只显示 🔊 */
  showIpa?: boolean;
  as?: "span" | "p" | "div";
  className?: string;
}) {
  const tokens = tokenizeWords(text);
  const [openWord, setOpenWord] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; bottom: boolean } | null>(null);
  const [ipa, setIpa] = useState<IpaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(`wt_${Math.random().toString(36).slice(2)}`);

  const close = useCallback(() => {
    setOpenWord(null);
    setIpa(null);
    setAnchor(null);
    setLoading(false);
    if (activeCloser) activeCloser = null;
  }, []);

  useEffect(() => {
    if (!openWord) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => close();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && popRef.current && popRef.current.contains(target)) return;
      if (target && (target as HTMLElement).closest?.('[data-word-ipa-anchor="1"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [openWord, close]);

  async function openFor(word: string, el: HTMLButtonElement) {
    if (openWord === word) {
      close();
      return;
    }
    if (activeCloser && activeCloser !== close) activeCloser();
    activeCloser = close;
    const rect = el.getBoundingClientRect();
    const isNarrow = typeof window !== "undefined" && window.innerWidth < 768;
    const bottom = !isNarrow && rect.bottom + 180 > window.innerHeight;
    setAnchor({ x: Math.min(Math.max(8, rect.left), window.innerWidth - 260), y: bottom ? rect.top : rect.bottom, bottom });
    setOpenWord(word);
    setIpa(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/words/${encodeURIComponent(word)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as IpaResult | null;
      // 404 = 词典未收录：前端显示「暂无音标」，不要报错弹窗
      setIpa(res.status === 404 || res.ok ? { word, ipa: body?.ipa ?? null, variants: body?.variants ?? [], syllables: body?.syllables ?? null, ipa_disabled: body?.ipa_disabled } : { word, ipa: null });
    } catch {
      setIpa({ word, ipa: null });
    } finally {
      setLoading(false);
    }
  }

  function playWord(word: string) {
    try {
      const audio = new Audio(`/api/tts?${new URLSearchParams({ text: word, rate: "slow", format: "mp3" }).toString()}`);
      void audio.play().catch(() => {
        /* 浏览器拦截：用户可再点一次 */
      });
    } catch {
      /* 静默：播放在极少数环境不可用 */
    }
  }

  return (
    <Tag className={className} data-wordtext={idRef.current}>
      {tokens.map((t, i) =>
        t.isWord ? (
          <button
            key={i}
            type="button"
            data-testid="word-token"
            data-word={t.text}
            data-word-ipa-anchor="1"
            aria-label={`查看 ${t.text} 的音标`}
            onClick={(e) => void openFor(t.text, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openFor(t.text, e.currentTarget);
              }
            }}
            className="inline rounded px-0.5 text-left underline decoration-dotted decoration-[#c3c8dd] underline-offset-2 hover:bg-[var(--ec-primary-soft)] focus:outline-none focus:ring-2 focus:ring-[var(--ec-primary)]"
          >
            {t.text}
          </button>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}

      {openWord ? (
        <div
          ref={popRef}
          data-testid="word-ipa-popover"
          role="dialog"
          aria-label={`${openWord} 的音标`}
          style={
            anchor && !anchor.bottom
              ? { position: "fixed", left: anchor.x, top: anchor.y + 6, zIndex: 60 }
              : anchor && anchor.bottom
                ? { position: "fixed", left: anchor.x, bottom: Math.max(8, window.innerHeight - anchor.y + 6), zIndex: 60 }
                : { position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 60 }
          }
          className="max-w-[90vw] rounded-2xl border border-[#d9dcf0] bg-white p-3 text-left shadow-xl min-w-[220px]"
        >
          <div className="flex items-center gap-2">
            <strong className="text-sm">{openWord}</strong>
            {showIpa && !ipa?.ipa_disabled ? (
              loading ? (
                <span className="text-xs text-[var(--ec-muted)]">音标…</span>
              ) : ipa?.ipa ? (
                <span className="text-sm font-mono" data-testid="word-ipa">
                  /{ipa.ipa}/
                </span>
              ) : (
                <span className="text-xs text-[var(--ec-muted)]" data-testid="word-ipa-missing">
                  暂无音标
                </span>
              )
            ) : null}
          </div>
          {showIpa && ipa?.variants && ipa.variants.length > 1 ? (
            <p className="mt-1 text-xs text-[var(--ec-muted)]">其它读音：{ipa.variants.slice(1).map((v) => `/${v}/`).join(" ")}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="word-ipa-play"
              className="ec-btn ec-btn-primary !px-2 !py-0.5 text-xs"
              onClick={() => playWord(openWord)}
            >
              🔊 听发音
            </button>
            {!showIpa || (!loading && ipa && !ipa.ipa) ? (
              <span className="text-xs text-[var(--ec-muted)]">{showIpa ? "可以先点 🔊 听发音" : "点 🔊 听一听"}</span>
            ) : null}
            <button type="button" className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs ml-auto" onClick={close} data-testid="word-ipa-close">
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </Tag>
  );
}
