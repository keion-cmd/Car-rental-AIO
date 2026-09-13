"use client";

import { usePathname } from "next/navigation";
import { ADMIN_NAV_ITEMS } from "../../../lib/admin/nav";

export function TopBar({
  user,
  logoutAction,
}: {
  user: { name: string; role: string };
  logoutAction: () => void;
}) {
  const pathname = usePathname();
  const current = ADMIN_NAV_ITEMS.find((item) =>
    item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href)
  );

  return (
    <header className="admin-topbar">
      <h2 className="admin-topbar-title">{current?.label ?? "Dashboard"}</h2>
      <div className="admin-topbar-actions">
        <button type="button" className="admin-bell" aria-label="Notifications">
          🔔
        </button>
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
