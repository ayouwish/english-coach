"use client";

import { useCallback, useRef, useState } from "react";

/**
 * 左划露出「删除」按钮的行容器（触摸屏与鼠标拖拽都支持）。
 *
 * 交互：
 * - 向右/向下拖：不拦截，交给页面正常滚动与点击；
 * - 向左拖超过约 1/3 宽度：松手后吸附到打开状态，露出删除按钮；
 * - 打开状态下点内容区：先收起，不触发内部链接跳转；
 * - 拖动过后不会误触发内部链接的点击（用 moved 阈值拦截 click）。
 *
 * 删除动作本身不弹确认框：由调用方在自己的 onDelete 里决定（各列表文案不同）。
 */
const ACTION_WIDTH = 88;

export function SwipeToDelete({
  children,
  onDelete,
  label = "删除",
  testId,
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  /** 执行删除；抛错时组件会恢复原状并把错误提示出来 */
  onDelete: () => void | Promise<void>;
  label?: string;
  testId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startRef = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null } | null>(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(0);

  const setOffsetBoth = useCallback((v: number) => {
    offsetRef.current = v;
    setOffset(v);
  }, []);

  const close = useCallback(() => setOffsetBoth(0), [setOffsetBoth]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || busy) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startRef.current = { x: e.clientX, y: e.clientY, base: offsetRef.current, axis: null };
    movedRef.current = 0;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    // 首次移动超过 6px 才判定方向，避免把轻点误判成拖动
    if (start.axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      start.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (start.axis === "x") {
        setDragging(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 老浏览器不支持捕获也不影响主流程 */
        }
      }
    }
    if (start.axis !== "x") return;

    movedRef.current = Math.max(movedRef.current, Math.abs(dx));
    const next = Math.max(-ACTION_WIDTH, Math.min(0, start.base + dx));
    setOffsetBoth(next);
  };

  const handlePointerUp = () => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.axis !== "x") {
      setDragging(false);
      return;
    }
    setDragging(false);
    setOffsetBoth(offsetRef.current < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0);
  };

  const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    // 刚拖动过：拦掉这次点击，避免误进详情页
    if (movedRef.current > 8) {
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = 0;
      return;
    }
    // 已划开时点内容 → 先收起
    if (offsetRef.current < 0) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const handleDelete = async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      close();
    } catch (err) {
      setError((err as Error).message || "删除失败，请重试");
      close();
    } finally {
      setBusy(false);
    }
  };

  const open = offset < 0;

  return (
    <div className={`relative overflow-hidden ${className}`} data-testid={testId ? `${testId}-root` : undefined}>
      {/* 底层：删除按钮（被上层内容盖住，左划后露出） */}
      <div
        className="absolute inset-y-0 right-0 z-0 flex"
        style={{ width: ACTION_WIDTH }}
        aria-hidden={!open}
      >
        <button
          type="button"
          data-testid={testId}
          tabIndex={open ? 0 : -1}
          aria-label={label}
          disabled={disabled || busy}
          onClick={() => void handleDelete()}
          className="flex h-full w-full items-center justify-center rounded-r-[inherit] bg-[#e5484d] text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "删除中…" : label}
        </button>
      </div>

      {/* 上层：内容，跟随手指平移 */}
      <div
        className="relative z-10"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 180ms ease",
          touchAction: "pan-y",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClickCapture={handleClickCapture}
      >
        {children}
      </div>

      {error ? (
        <p role="alert" className="relative z-10 bg-[#fff3d6] px-2 py-1 text-xs text-[#7a4d00]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
