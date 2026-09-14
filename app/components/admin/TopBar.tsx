"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV_ITEMS } from "../../../lib/admin/nav";

export function TopBar({
  user,
  logoutAction,
  needsAttentionCount,
}: {
  user: { name: string; role: string };
  logoutAction: () => void;
  needsAttentionCount: number;
}) {
  const pathname = usePathname();
  const current = ADMIN_NAV_ITEMS.find((item) =>
    item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href)
  );

  return (
    <header className="admin-topbar">
      <h2 className="admin-topbar-title">{current?.label ?? "Dashboard"}</h2>
      <div className="admin-topbar-actions">
        <Link
          href="/admin/bookings?view=needsAttention"
          className="admin-bell"
          aria-label={`Notifications: ${needsAttentionCount} needing attention`}
        >
          🔔
          {needsAttentionCount > 0 && <span className="admin-bell-count">{needsAttentionCount}</span>}
        </Link>
        <div className="admin-user-menu">
          <span className="admin-user-name">{user.name}</span>
          <span className="admin-user-role">{user.role}</span>
          <form action={logoutAction}>
            <button type="submit" className="outline-button">
              Log out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
