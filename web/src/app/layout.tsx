import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser, type SessionUser } from "@/lib/auth";
import { NavBar } from "@/components/NavBar";

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
  return (
    <html lang="zh-CN">
      <body data-child={user?.isChild ? "true" : "false"}>
        <NavBar user={user} />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-[var(--ec-muted)]">
          English Coach v0.1 · web ↔ voice(FastAPI) 契约 v1 · 音频文件不入库
        </footer>
      </body>
    </html>
  );
}
