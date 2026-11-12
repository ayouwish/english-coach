"use client";

import { usePathname } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import type { SessionUser } from "@/lib/auth";

/** 全站外壳（task-110）：管理员后台 /admin* 使用独立布局，不套家庭导航/页脚。 */
export function SiteChrome({ user, children }: { user: SessionUser | null; children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  if (isAdmin) {
    return <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">{children}</main>;
  }
  return (
    <>
      <NavBar user={user} />
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-[var(--ec-muted)]">
        English Coach v0.1 · web ↔ voice(FastAPI) 契约 v1 · 音频文件不入库
      </footer>
    </>
  );
}
