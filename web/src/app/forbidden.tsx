"use client";

import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="mx-auto max-w-lg">
      <div className="ec-card text-center">
        <div className="text-4xl">🔒</div>
        <h1 className="mt-2 text-xl font-extrabold">403 · 这里只有家长能进</h1>
        <p className="mt-2 text-sm text-[var(--ec-muted)]">
          家长面板包含全家人的学习数据。小朋友的账号看不到这里哦，去跟读练习或错音本玩吧！
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/practice" className="ec-btn ec-btn-primary">
            🎤 去跟读练习
          </Link>
          <Link href="/" className="ec-btn ec-btn-ghost">
            回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
