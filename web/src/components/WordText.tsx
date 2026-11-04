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
  ipa_disabled?: boolean;
}

/** 长按阈值：450ms（task-94） */
const LONG_PRESS_MS = 450;
/** 手指/鼠标移动超过 8px 视为滑动，取消长按 */
const MOVE_CANCEL_PX = 8;
/** 窄屏（<480px）用底部 sheet；否则在词下方浮层 */
const NARROW_SHEET_PX = 480;
/** 浮层尺寸估算（用于 decide 上下/居中） */
const POP_W = 240;
const POP_H = 96;

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

interface Anchor {
  left: number;
  top: number;
  placement: "below" | "above" | "sheet";
}

/**
 * 可点单词正文（task-87 / 88 / 94）：**长按**单词在**下方**显示音标（不发音）。
 *
 * 元素（task-96）：`<span role="button" tabIndex={0}>` 而不是 `<button>` —— 用户浏览器扩展会注入全局
 * `button { padding: 0 24px }`，把每个词撑开 48px；span 不会命中该选择器（CSS 另有 !important 归零兜底）。
 * 排版（task-94 bug 修复）：强制 `font: inherit` 等全部文字度量（见 globals.css `.word-token`），
 * 不加任何 padding/下划线/圆角等装饰类 → 整句与普通文本完全一致，词间只有一个空格。
 * 交互：pointerdown 起 450ms 计时；位移 >8px / pointerup / pointercancel 取消；普通点击不打开。
 * 浮层：优先单词正下方（rect.bottom + 6，水平居中），下方不够才翻上方；窄屏底部 sheet。
 * 关闭：再长按同词 / 点空白 / Esc / 滚轮滚动。没有关闭图标按钮、没有发音按钮、无 TTS。
 */
export function WordText({
  text,
  showIpa = true,
  as: Tag = "span",
  className = "",
}: {
  text: string;
  /** 是否渲染 IPA（设置开关；关闭时浮层显示「音标已关闭」） */
  showIpa?: boolean;
  as?: "span" | "p" | "div";
  className?: string;
}) {
  const tokens = tokenizeWords(text);
  const [openWord, setOpenWord] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [ipa, setIpa] = useState<IpaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpenWord(null);
    setIpa(null);
    setAnchor(null);
    setLoading(false);
    if (activeCloser) activeCloser = null;
  }, [clearTimer]);

  useEffect(() => {
    if (!openWord) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // 滚屏/滚轮关闭（捕获阶段处理内部滚动容器）
    const onScroll = () => close();
    const onWheel = () => close();
    const onDown = (e: MouseEvent | PointerEvent) => {
      const target = e.target as Node | null;
      if (target && popRef.current && popRef.current.contains(target)) return;
      if (target && (target as HTMLElement).closest?.('[data-word-ipa-anchor="1"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [openWord, close]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  /** 计算浮层位置：优先单词正下方，放不下翻上方；窄屏底部 sheet */
  function placementFor(el: HTMLElement): Anchor {
    const rect = el.getBoundingClientRect();
    if (typeof window !== "undefined" && window.innerWidth < NARROW_SHEET_PX) {
      return { left: 12, top: 0, placement: "sheet" };
    }
    const centerLeft = rect.left + rect.width / 2 - POP_W / 2;
    const left = Math.min(Math.max(8, centerLeft), Math.max(8, window.innerWidth - POP_W - 8));
    const below = rect.bottom + 6;
    const fitsBelow = below + POP_H <= window.innerHeight - 8;
    if (fitsBelow) return { left, top: below, placement: "below" };
    const above = rect.top - POP_H - 6;
    if (above >= 8) return { left, top: above, placement: "above" };
    return { left, top: below, placement: "below" };
  }

  async function openFor(word: string, el: HTMLElement) {
    if (openWord === word) {
      close();
      return;
    }
    if (activeCloser && activeCloser !== close) activeCloser();
    activeCloser = close;
    setAnchor(placementFor(el));
    setOpenWord(word);
    setIpa(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/words/${encodeURIComponent(word)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as IpaResult | null;
      setIpa(
        res.status === 404 || res.ok
          ? { word, ipa: body?.ipa ?? null, variants: body?.variants ?? [], ipa_disabled: body?.ipa_disabled }
          : { word, ipa: null },
      );
    } catch {
      setIpa({ word, ipa: null });
    } finally {
      setLoading(false);
    }
  }

  /** pointerdown：开始计时长按（普通点击不会打开） */
  function onPointerDown(word: string, e: React.PointerEvent<HTMLSpanElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = e.currentTarget;
    clearTimer();
    startRef.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      startRef.current = null;
      void openFor(word, el);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const start = startRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - start.y) > MOVE_CANCEL_PX) {
      clearTimer();
    }
  }

  return (
    <Tag className={className} data-wordtext="1">
      {tokens.map((t, i) =>
        t.isWord ? (
          <span
            key={i}
            role="button"
            tabIndex={0}
            data-testid="word-token"
            data-word={t.text}
            data-word-ipa-anchor="1"
            aria-label={`长按查看 ${t.text} 的音标`}
            className="word-token"
            style={{ touchAction: "manipulation", WebkitUserSelect: "none", userSelect: "none" }}
            onPointerDown={(e) => onPointerDown(t.text, e)}
            onPointerMove={onPointerMove}
            onPointerUp={clearTimer}
            onPointerCancel={clearTimer}
            onPointerLeave={clearTimer}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              // 键盘可访问：Enter/Space 直接打开（无需长按）
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openFor(t.text, e.currentTarget);
              }
            }}
          >
            {t.text}
          </span>
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
            anchor?.placement === "sheet"
              ? { position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 60 }
              : anchor
                ? { position: "fixed", left: anchor.left, top: anchor.top, width: POP_W, zIndex: 60 }
                : { position: "fixed", left: 12, bottom: 12, zIndex: 60 }
          }
          className="rounded-xl border border-[#d9dcf0] bg-white px-3 py-2 shadow-lg"
        >
          <div className="flex items-baseline gap-2">
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
          {!showIpa ? (
            <p className="mt-1 text-xs text-[var(--ec-muted)]" data-testid="word-ipa-off">
              音标已关闭；可在「设置 → 单词显示音标」里打开。
            </p>
          ) : null}
        </div>
      ) : null}
    </Tag>
  );
}
