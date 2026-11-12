"use client";

export function AdminLogoutButton() {
  return (
    <button
      type="button"
      className="ec-btn ec-btn-ghost !px-2 !py-0.5 text-xs"
      data-testid="admin-logout"
      onClick={async () => {
        await fetch("/api/admin/logout", { method: "POST" }).catch(() => undefined);
        window.location.href = "/admin/login";
      }}
    >
      退出后台
    </button>
  );
}
