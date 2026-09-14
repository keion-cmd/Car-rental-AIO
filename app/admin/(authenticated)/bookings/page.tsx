import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";
import { Card } from "../../../components/admin/Card";
import { StatusBadge } from "../../../components/admin/StatusBadge";
import { formatMoney } from "../../../../lib/money";
import { listLocations } from "../../../../lib/services/catalog.service";
import {
  listBookings,
  countsForViews,
  SAVED_VIEWS,
  type SavedView,
  type SortField,
  type SortDir,
  type ListBookingsFilters,
} from "../../../../lib/services/booking-query.service";
import type { BookingStatus, PaymentStatus } from "@prisma/client";

export const metadata: Metadata = {
  title: "Bookings | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const BOOKING_STATUSES: BookingStatus[] = ["PENDING", "CONFIRMED", "ONGOING", "COMPLETED", "CANCELLED"];
const PAYMENT_STATUSES: PaymentStatus[] = ["UNPAID", "PARTIALLY_PAID", "PAID", "REFUNDED", "FAILED"];
const SORT_FIELDS: SortField[] = ["pickup", "return", "created", "total"];

function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-PH", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(date);
}

function buildQuery(base: RawParams, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (key === "cursor") continue; // never carry a stale cursor across a filter/view/sort change
    const v = one(value);
    if (v) params.set(key, v);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

export default async function AdminBookingsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireAuth("STAFF");
  const raw = await searchParams;

  const view = (one(raw.view) as SavedView | undefined) ?? "all";
  const search = one(raw.search);
  const status = one(raw.status) as BookingStatus | undefined;
  const paymentStatus = one(raw.paymentStatus) as PaymentStatus | undefined;
  const pickupLocationId = one(raw.locationId);
  const dateFrom = one(raw.dateFrom) ? new Date(one(raw.dateFrom)!) : undefined;
  const dateTo = one(raw.dateTo) ? new Date(one(raw.dateTo)!) : undefined;
  const sortBy = (one(raw.sortBy) as SortField | undefined) ?? "pickup";
  const sortDir = (one(raw.sortDir) as SortDir | undefined) ?? "asc";
  const cursor = one(raw.cursor);

  const filters: ListBookingsFilters = { view, search, status, paymentStatus, pickupLocationId, dateFrom, dateTo, sortBy, sortDir };
  const now = new Date();

  const [{ rows, nextCursor }, counts, locations] = await Promise.all([
    listBookings(filters, { cursor, limit: 20 }, now),
    countsForViews({ search, status, paymentStatus, pickupLocationId, dateFrom, dateTo }, now),
    listLocations(),
  ]);

  const activeView = SAVED_VIEWS.find((v) => v.id === view) ?? SAVED_VIEWS[SAVED_VIEWS.length - 1];

  return (
    <>
      <PageHeader title="Bookings" description="The reservation queue: pending, confirmed, ongoing and completed." />

      <div className="admin-tabs">
        {SAVED_VIEWS.map((v) => (
          <Link
            key={v.id}
            href={`/admin/bookings?${buildQuery(raw, { view: v.id })}`}
            className={`admin-tab${v.id === view ? " admin-tab-active" : ""}`}
          >
            {v.label} <span className="admin-tab-count">{counts[v.id]}</span>
          </Link>
        ))}
      </div>

      <Card className="admin-filter-bar">
        <form method="get" className="admin-filter-form">
          <input type="hidden" name="view" value={view} />
          <input type="search" name="search" placeholder="Reference, customer, email, phone or plate" defaultValue={search ?? ""} />
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select name="paymentStatus" defaultValue={paymentStatus ?? ""}>
            <option value="">Any payment</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select name="locationId" defaultValue={pickupLocationId ?? ""}>
            <option value="">Any location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <label className="admin-filter-date">
            From
            <input type="date" name="dateFrom" defaultValue={one(raw.dateFrom) ?? ""} />
          </label>
          <label className="admin-filter-date">
            To
            <input type="date" name="dateTo" defaultValue={one(raw.dateTo) ?? ""} />
          </label>
          <select name="sortBy" defaultValue={sortBy}>
            {SORT_FIELDS.map((f) => (
              <option key={f} value={f}>Sort: {f}</option>
            ))}
          </select>
          <select name="sortDir" defaultValue={sortDir}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="submit" className="outline-button">Apply</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState heading={activeView.label} description={activeView.emptyDescription} />
      ) : (
        <Card>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Pickup</th>
                  <th>Return</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Total</th>
                  <th>Balance due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/bookings/${row.id}`}>{row.reference}</Link>
                      <div className="admin-table-flags">
                        {row.needsAttention && <span className="admin-flag admin-flag-attention">Needs attention</span>}
                        {row.isOverdue && <span className="admin-flag admin-flag-overdue">Overdue</span>}
                        {row.isStartingToday && <span className="admin-flag admin-flag-today">Pickup today</span>}
                        {row.isReturningToday && <span className="admin-flag admin-flag-today">Return today</span>}
                      </div>
                    </td>
                    <td>{row.customerName}</td>
                    <td>{row.vehicleLabel} · {row.plateNumber}</td>
                    <td>{formatDateTime(row.pickupAt, row.pickupLocationTimezone)}<br /><small>{row.pickupLocationName}</small></td>
                    <td>{formatDateTime(row.returnAt, row.pickupLocationTimezone)}<br /><small>{row.dropoffLocationName}</small></td>
                    <td><StatusBadge variant={row.status} /></td>
                    <td><StatusBadge variant={row.paymentStatus} /></td>
                    <td>{formatMoney(row.totalAmount, row.currency)}</td>
                    <td>{formatMoney(row.balanceDue, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor && (
            <div className="admin-pagination">
              <Link href={`/admin/bookings?${buildQuery(raw, { cursor: nextCursor })}`} className="outline-button">
                Next page →
              </Link>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
