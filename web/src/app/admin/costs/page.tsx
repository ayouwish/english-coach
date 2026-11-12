import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** task-110：后台统一入口改为 /admin。 */
export default async function AdminCostsRedirect({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  redirect(sp.month ? `/admin?month=${encodeURIComponent(sp.month)}` : "/admin");
}
