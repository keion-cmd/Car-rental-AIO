import type { UserRole } from "@prisma/client";

// Order follows counter-staff frequency of use, not data hierarchy — the
// first four items must never require scrolling. This list is the single
// source for both the sidebar (presentation) and the route-level minimum
// role passed to requireAuth() in each page.tsx (the actual gate). Hiding
// an item here is UX only; it does not substitute for requireAuth.
export interface AdminNavItem {
  label: string;
  href: string;
  minRole: UserRole;
  description: string;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { label: "Overview", href: "/admin", minRole: "STAFF", description: "Daily snapshot of what needs attention." },
  { label: "Bookings", href: "/admin/bookings", minRole: "STAFF", description: "Reservation queue and status." },
  { label: "Calendar", href: "/admin/calendar", minRole: "STAFF", description: "Fleet availability by date." },
  { label: "Fleet", href: "/admin/fleet", minRole: "STAFF", description: "Vehicles, condition and blocks." },
  { label: "Customers", href: "/admin/customers", minRole: "MANAGER", description: "Renter profiles and history." },
  { label: "Payments", href: "/admin/payments", minRole: "MANAGER", description: "Deposits, balances and refunds." },
  { label: "Reports", href: "/admin/reports", minRole: "MANAGER", description: "Utilization and revenue summaries." },
  { label: "Locations", href: "/admin/locations", minRole: "ADMIN", description: "Branches and pickup points." },
  { label: "Pricing", href: "/admin/pricing", minRole: "ADMIN", description: "Rate rules and surcharges." },
  { label: "CMS", href: "/admin/cms", minRole: "ADMIN", description: "Public site content. Built in P7." },
  { label: "Settings", href: "/admin/settings", minRole: "OWNER", description: "Company-wide configuration." },
  { label: "Audit", href: "/admin/audit", minRole: "OWNER", description: "Who changed what, and when." },
];
