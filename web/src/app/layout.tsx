import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser, type SessionUser } from "@/lib/auth";
import { SiteChrome } from "@/components/SiteChrome";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "English Coach · 家庭英语练习",
  description: "音素级发音纠正 + 日常对话训练 + 错音本 SRS + 家长面板",
};

async function safeUser(): Promise<SessionUser | null> {
  try {
    return await getCurrentUser();
  } catch {
    // 首次启动、数据库还没建表时不要让整站崩掉
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await safeUser();
  // middleware 注入 pathname：/admin* 使用独立布局（不套家庭导航），SSR 也正确
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  const isAdminChrome = pathname === "/admin" || pathname.startsWith("/admin/");
  return (
    <html lang="zh-CN">
      <body data-child={user?.isChild ? "true" : "false"}>
        {isAdminChrome ? (
          <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">{children}</main>
        ) : (
          <SiteChrome user={user}>{children}</SiteChrome>
        )}
      </body>
    </html>
  );
}
