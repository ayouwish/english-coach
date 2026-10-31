import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { SuggestButton } from "./SuggestButton";

const BASE_LINKS = [
  { href: "/practice", label: "🎤 跟读练习" },
  { href: "/flow", label: "🔗 连读模式" },
  { href: "/story", label: "📖 我的故事" },
  { href: "/chat", label: "💬 对话训练" },
  { href: "/review", label: "📒 错音本" },
  { href: "/blindtest", label: "🎯 盲测周报" },
  { href: "/report", label: "🔍 发音诊断" },
  { href: "/settings", label: "⚙️ 设置" },
];

export function NavBar({ user }: { user: SessionUser | null }) {
  const links = user
    ? user.role === "parent"
      ? [...BASE_LINKS, { href: "/parent", label: "👨‍👩‍👧 家长面板" }]
      : BASE_LINKS
    : [];

  return (
    <header className="sticky top-0 z-20 border-b border-black/5 bg-white/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          English&nbsp;Coach
        </Link>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-1.5 font-medium text-[var(--ec-muted)] hover:bg-[var(--ec-primary-soft)] hover:text-[var(--ec-ink)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <SuggestButton isChild={user.isChild} />
              <span className="font-semibold">
                {user.avatarImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本地 API 图片
                  <img
                    src="/api/avatar/image"
                    alt={`${user.displayName} 的虚拟形象`}
                    data-testid="nav-avatar"
                    className="mr-1 inline-block h-7 w-7 rounded-full border border-[#e6e8f5] align-middle object-cover"
                  />
                ) : (
                  <span aria-hidden>{user.avatar ?? "🙂"}</span>
                )}{" "}
                {user.displayName}
                <span className="ml-2 rounded-full bg-[var(--ec-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--ec-primary)]">
                  {user.role === "parent" ? "家长" : "小朋友"}
                </span>
              </span>
              <LogoutButton />
            </>
          ) : (
            <Link href="/login" className="ec-btn ec-btn-primary">
              登录
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
