import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth, roleSatisfies } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";
import { Card } from "../../components/admin/Card";
import { StatusBadge, type StatusBadgeVariant } from "../../components/admin/StatusBadge";
import { formatMoney } from "../../../lib/money";
import { listLocations, getCurrency } from "../../../lib/services/catalog.service";
import { listVehicles, listVehicleCategories, type VehicleStatus } from "../../../lib/services/fleet.service";

export const metadata: Metadata = {
  title: "Fleet | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "RESERVED", "MAINTENANCE", "BLOCKED"];

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(date);
}

export default async function AdminFleetPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const user = await requireAuth("STAFF");
  const raw = await searchParams;

  const status = one(raw.status) as VehicleStatus | undefined;
  const categoryId = one(raw.categoryId);
  const locationId = one(raw.locationId);
  const bookableOnlineRaw = one(raw.bookableOnline);
  const bookableOnline = bookableOnlineRaw === "true" ? true : bookableOnlineRaw === "false" ? false : undefined;
  const archived = one(raw.archived) === "true";
  const search = one(raw.search);

  const now = new Date();
  const [rows, categories, locations, currency] = await Promise.all([
    listVehicles({ status, categoryId, locationId, bookableOnline, archived, search }, now),
    listVehicleCategories(),
    listLocations(),
    getCurrency(),
  ]);

  const canManage = roleSatisfies(user.role, "MANAGER");

  return (
    <>
      <PageHeader
        title="Fleet"
        description="Vehicles, their live status, and where they sit right now."
        action={
          canManage ? (
            <Link href="/admin/fleet/new" className="admin-primary-button" style={{ textDecoration: "none", display: "inline-block" }}>
              Add vehicle
            </Link>
          ) : undefined
        }
      />

      <Card className="admin-filter-bar">
        <form method="get" className="admin-filter-form">
          <input type="search" name="search" placeholder="Plate, make or model" defaultValue={search ?? ""} />
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select name="categoryId" defaultValue={categoryId ?? ""}>
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select name="locationId" defaultValue={locationId ?? ""}>
            <option value="">Any location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <select name="bookableOnline" defaultValue={bookableOnlineRaw ?? ""}>
            <option value="">Bookable: any</option>
            <option value="true">Bookable online</option>
            <option value="false">Not bookable online</option>
          </select>
          <label className="admin-filter-date">
            <input type="checkbox" name="archived" value="true" defaultChecked={archived} />
            Show archived
          </label>
          <button type="submit" className="outline-button">Apply</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          heading={archived ? "No archived vehicles" : "No vehicles match these filters"}
          description={archived ? "Nothing has been archived yet." : "Try widening the status, category or location filters."}
        />
      ) : (
        <Card>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>Vehicle</th>
                  <th>Plate</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th>Daily rate</th>
                  <th>Next booking</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={row.imageUrl} alt={`${row.make} ${row.model}`} style={{ width: 56, height: 40, objectFit: "cover", borderRadius: 4 }} />
                      ) : (
                        <div style={{ width: 56, height: 40, borderRadius: 4, background: "var(--admin-muted, #eee)" }} />
                      )}
                    </td>
                    <td>
                      <Link href={`/admin/fleet/${row.id}`}>{row.make} {row.model}</Link>
                      {row.archivedAt && <div><small>Archived {formatDate(row.archivedAt)}</small></div>}
                    </td>
                    <td>{row.plateNumber}</td>
                    <td>{row.categoryName}</td>
                    <td><StatusBadge variant={row.status as StatusBadgeVariant} /></td>
                    <td>{row.currentLocationName}</td>
                    <td>{formatMoney(row.dailyRate, currency)}</td>
                    <td>{row.nextBookingAt ? formatDate(row.nextBookingAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
