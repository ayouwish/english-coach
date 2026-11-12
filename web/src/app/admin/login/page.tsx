import { adminEnabled } from "@/lib/admin-auth";
import { AdminLoginForm } from "./AdminLoginForm";

export const dynamic = "force-dynamic";

/** /admin/login —— 独立后台登录（task-110）：只输入管理员密码。 */
export default function AdminLoginPage() {
  return (
    <div className="mx-auto max-w-sm">
      <div className="ec-card">
        <h1 className="text-xl font-extrabold">🔐 管理员后台</h1>
        <p className="mt-1 text-xs text-[var(--ec-muted)]">独立后台入口（不使用家庭账号）。</p>
        <AdminLoginForm enabled={adminEnabled()} />
      </div>
    </div>
  );
}
