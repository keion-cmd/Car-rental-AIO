import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";
import { Card } from "../../components/admin/Card";
import { formatMoney } from "../../../lib/money";
import { getCurrency } from "../../../lib/services/catalog.service";
import { listCustomers, type ListCustomersFilters } from "../../../lib/services/customer-query.service";

export const metadata: Metadata = {
  title: "Customers | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(date);
}

const FLAG_LABEL: Record<string, string> = {
  VIP: "VIP",
  REQUIRES_DEPOSIT: "Requires deposit",
  BLACKLISTED: "Blacklisted",
};

const FLAG_CLASS: Record<string, string> = {
  VIP: "admin-badge-blue",
  REQUIRES_DEPOSIT: "admin-badge-amber",
  BLACKLISTED: "admin-badge-red",
};

export default async function AdminCustomersPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  // This is PII, not counter-staff data — STAFF may not see this list.
  await requireAuth("MANAGER");
  const raw = await searchParams;

  const search = one(raw.search);
  const hasActiveRental = one(raw.hasActiveRental) === "true";
  const hasOutstandingBalance = one(raw.hasOutstandingBalance) === "true";
  const flagged = one(raw.flagged) === "true";
  const repeatCustomer = one(raw.repeatCustomer) === "true";
  const cursor = one(raw.cursor);

  const filters: ListCustomersFilters = { search, hasActiveRental, hasOutstandingBalance, flagged, repeatCustomer };
  const now = new Date();

  const [{ rows, nextCursor }, currency] = await Promise.all([
    listCustomers(filters, { cursor }, now),
    getCurrency(),
  ]);

  const filterParams = new URLSearchParams();
  if (search) filterParams.set("search", search);
  if (hasActiveRental) filterParams.set("hasActiveRental", "true");
  if (hasOutstandingBalance) filterParams.set("hasOutstandingBalance", "true");
  if (flagged) filterParams.set("flagged", "true");
  if (repeatCustomer) filterParams.set("repeatCustomer", "true");

  return (
    <>
      <PageHeader title="Customers" description="Renter profiles, contact details and rental history." />

      <Card className="admin-filter-bar">
        <form method="get" className="admin-filter-form">
          <input type="search" name="search" placeholder="Name, email or phone" defaultValue={search ?? ""} />
          <label className="admin-filter-date">
            <input type="checkbox" name="hasActiveRental" value="true" defaultChecked={hasActiveRental} />
            Active rental
          </label>
          <label className="admin-filter-date">
            <input type="checkbox" name="hasOutstandingBalance" value="true" defaultChecked={hasOutstandingBalance} />
            Outstanding balance
          </label>
          <label className="admin-filter-date">
            <input type="checkbox" name="flagged" value="true" defaultChecked={flagged} />
            Flagged
          </label>
          <label className="admin-filter-date">
            <input type="checkbox" name="repeatCustomer" value="true" defaultChecked={repeatCustomer} />
            Repeat customer
          </label>
          <button type="submit" className="outline-button">Apply</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          heading="No customers match these filters"
          description="Try widening the search or clearing a filter."
        />
      ) : (
        <Card>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Total bookings</th>
                  <th>Last rental</th>
                  <th>Outstanding balance</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><Link href={`/admin/customers/${row.id}`}>{row.name}</Link></td>
                    <td>{row.email}</td>
                    <td>{row.phone ?? "—"}</td>
                    <td>{row.totalBookings}</td>
                    <td>{row.lastRentalAt ? formatDate(row.lastRentalAt) : "—"}</td>
                    <td>{formatMoney(row.outstandingBalance, currency)}</td>
                    <td>
                      {row.flag && (
                        <span className={`admin-badge ${FLAG_CLASS[row.flag]}`}>{FLAG_LABEL[row.flag]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div style={{ marginTop: 16 }}>
              <Link
                href={`/admin/customers?${new URLSearchParams({ ...Object.fromEntries(filterParams), cursor: nextCursor }).toString()}`}
                className="outline-button"
              >
                Next page
              </Link>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
