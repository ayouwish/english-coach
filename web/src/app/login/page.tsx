import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { applyAccountOverrides } from "@/db/bootstrap";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm, type DemoAccount } from "./LoginForm";

export const dynamic = "force-dynamic";

/**
 * 演示账号快捷填充。
 *
 * ⚠️ 这里刻意**不硬编码密码**：种子密码会被部署时的 `BOOTSTRAP_*_PASSWORD` 覆盖
 * （见 deploy/.env），一旦被覆盖，前端写死的 `Dad12345!` 之类就一定是错的 ——
 * 用户点一下按钮 → 填了错密码 → 看到"邮箱或密码不正确"，非常难自查。
 * 所以只在**三个密码都没被覆盖**（仍是内置默认值）时才带上密码；否则只填邮箱。
 */
function buildDemoAccounts(): { accounts: DemoAccount[]; passwordsAreDefault: boolean } {
  const passwordsAreDefault = [
    process.env.BOOTSTRAP_DAD_PASSWORD,
    process.env.BOOTSTRAP_MOM_PASSWORD,
    process.env.BOOTSTRAP_CHILD_PASSWORD,
  ].every((v) => !v || !String(v).trim());

  const accounts = applyAccountOverrides().map((a) => ({
    label: `${a.avatar ?? ""} ${a.displayName}${a.role === "parent" ? "（家长）" : "（儿童）"}`.trim(),
    email: a.email,
    // 密码没被覆盖时才知道它是什么；被覆盖过就不猜（只填邮箱，避免"填对账号、填错密码"）
    password: passwordsAreDefault ? a.password : null,
  }));
  return { accounts, passwordsAreDefault };
}

export default async function LoginPage() {
  await ensureBootstrap();
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/");
  const { accounts, passwordsAreDefault } = buildDemoAccounts();
  return (
    <div className="mx-auto max-w-md">
      <div className="ec-card">
        <h1 className="text-2xl font-extrabold">登录 English Coach</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          一家三口各自登录：爸爸、妈妈是家长账号，女儿是儿童账号（大按钮、不显示 IPA、到点自动收尾）。
        </p>
        <LoginForm demoAccounts={accounts} passwordsAreDefault={passwordsAreDefault} />
      </div>
    </div>
  );
}
