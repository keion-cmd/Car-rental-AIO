"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import type { AdminNavItem } from "../../../lib/admin/nav";

// `items` arrives pre-filtered by the server layout (guard.ts's
// roleSatisfies() is server-only — it pulls in next/headers via
// requireAuth — so it cannot be imported into this client component).
// That filtering is presentation only — it decides what a user sees, not
// what they can reach. Every route behind these links independently calls
// requireAuth() with its own minimum role; a hidden link is not a gate.
export function Sidebar({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`admin-sidebar${collapsed ? " admin-sidebar-collapsed" : ""}`}>
      <button
        type="button"
        className="admin-sidebar-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
      >
        {collapsed ? "»" : "«"}
      </button>
      <nav className="admin-nav">
        {items.map((item) => {
          const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
          return (
            <a key={item.href} href={item.href} className={`admin-nav-item${active ? " admin-nav-item-active" : ""}`}>
              <span className="admin-nav-dot" aria-hidden="true" />
              <span className="admin-nav-label">{item.label}</span>
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
