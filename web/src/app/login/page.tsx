import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await ensureBootstrap();
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/");
  return (
    <div className="mx-auto max-w-md">
      <div className="ec-card">
        <h1 className="text-2xl font-extrabold">登录 English Coach</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          一家三口各自登录：爸爸、妈妈是家长账号，女儿是儿童账号（大按钮、不显示 IPA、到点自动收尾）。
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
