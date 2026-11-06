import { allowSelfSignup } from "@/lib/families";
import { RegisterForm } from "./RegisterForm";

export const dynamic = "force-dynamic";

/** /register（task-97/99）：创建家庭 或 用邀请码加入（ALLOW_SELF_SIGNUP=0 时关闭前者）。 */
export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-md">
      <div className="ec-card">
        <h1 className="text-2xl font-extrabold">开始使用 English Coach</h1>
        <p className="mt-1 text-sm text-[var(--ec-muted)]">
          每个家庭独立使用、互相看不到数据。创建一个新家庭，或用家长分享的邀请码加入。
        </p>
        <RegisterForm allowSelfSignup={allowSelfSignup()} />
      </div>
    </div>
  );
}
