import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireAuth, roleSatisfies } from "../../lib/auth/guard";
import { logoutAction } from "../actions/auth";
import { ADMIN_NAV_ITEMS } from "../../lib/admin/nav";
import { Sidebar } from "../components/admin/Sidebar";
import { TopBar } from "../components/admin/TopBar";
import { countsForViews } from "../../lib/services/booking-query.service";

export const metadata: Metadata = {
  title: "Dashboard | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

// Reads the session cookie per request — never cached or frozen at build
// time. requireAuth(STAFF) here is the gate for the whole /admin tree;
// each page under it also calls requireAuth with its own (equal or higher)
// minimum role, since a layout guard alone would let a STAFF session render
// an OWNER-only page's shell before the page itself redirects.
export const dynamic = "force-dynamic";

// This tree is deliberately self-contained: it does not import SiteFooter
// (the public marketing footer), which public pages under app/ render for
// themselves rather than the root layout injecting it globally. Nothing
// here needs to "opt out" of it — there is nothing global to opt out of.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAuth("STAFF");
  const items = ADMIN_NAV_ITEMS.filter((item) => roleSatisfies(user.role, item.minRole));

  // The bell needs a count on every admin page, not only the overview, so
  // it is read here rather than passed down from app/admin/page.tsx.
  const counts = await countsForViews({}, new Date());

  return (
    <div className="admin-shell">
      <Sidebar items={items} />
      <div className="admin-main">
        <TopBar user={{ name: user.name, role: user.role }} logoutAction={logoutAction} needsAttentionCount={counts.needsAttention} />
        <div className="admin-content">{children}</div>
      </div>
    </div>
  );
}
