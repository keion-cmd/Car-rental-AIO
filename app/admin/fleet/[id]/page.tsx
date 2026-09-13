import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, roleSatisfies } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { Card } from "../../../components/admin/Card";
import { StatusBadge, type StatusBadgeVariant } from "../../../components/admin/StatusBadge";
import { formatMoney } from "../../../../lib/money";
import { getCurrency } from "../../../../lib/services/catalog.service";
import { getVehicleDetail } from "../../../../lib/services/fleet.service";
import {
  updateVehicleAction,
  archiveVehicleAction,
  setBookableOnlineAction,
  addVehicleImageAction,
  removeVehicleImageAction,
  setPrimaryImageAction,
  createMaintenanceAction,
  completeMaintenanceAction,
  createManualBlockAction,
  removeManualBlockAction,
} from "../../../actions/fleet";

export const metadata: Metadata = {
  title: "Vehicle detail | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Tab = "overview" | "pricing" | "availability" | "maintenance" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pricing", label: "Pricing" },
  { id: "availability", label: "Availability" },
  { id: "maintenance", label: "Maintenance" },
  { id: "history", label: "Rental history" },
];

const ERROR_MESSAGES: Record<string, string> = {
  "invalid-input": "Enter valid values before submitting.",
  "has-future-bookings": "This vehicle has future bookings and cannot be archived. Reassign or cancel them first.",
  "maintenance-conflicts-with-bookings": "That maintenance window overlaps an existing booking. Cancel or reschedule the conflicting bookings first.",
  "vehicle-unavailable": "That window overlaps an existing block or booking for this vehicle.",
};

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function toDateTimeLocal(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function minorToDecimalString(amount: bigint): string {
  const negative = amount < BigInt(0);
  const abs = negative ? -amount : amount;
  const major = abs / BigInt(100);
  const minor = abs % BigInt(100);
  return `${negative ? "-" : ""}${major}.${minor.toString().padStart(2, "0")}`;
}

export default async function VehicleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth("STAFF");
  const canEdit = roleSatisfies(user.role, "MANAGER");
  const { id } = await params;
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = (one(raw.tab) as Tab | undefined) ?? "overview";
  const errorFlag = one(raw.error);
  const conflictRefs = one(raw.conflicts)?.split(",").filter(Boolean) ?? [];

  const now = new Date();
  const [detail, currency] = await Promise.all([getVehicleDetail(id, now), getCurrency()]);
  if (!detail) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={`${detail.make} ${detail.model} · ${detail.plateNumber}`}
        description={`${detail.categoryName} · ${detail.seats} seats · ${detail.transmission} · ${detail.fuelType}`}
        action={<Link href="/admin/fleet" className="outline-button">← Back to fleet</Link>}
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
          {conflictRefs.length > 0 && (
            <ul>
              {conflictRefs.map((ref) => (
                <li key={ref}>{ref}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Card className="admin-status-header">
        <StatusBadge variant={detail.status as StatusBadgeVariant} />
        {detail.archivedAt && <span className="admin-flag admin-flag-attention">Archived {formatDateTime(detail.archivedAt)}</span>}
        {!detail.isBookableOnline && <span className="admin-flag admin-flag-attention">Not bookable online</span>}
      </Card>

      <div className="admin-tabs">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/admin/fleet/${id}?tab=${t.id}`}
            className={`admin-tab${t.id === tab ? " admin-tab-active" : ""}`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "overview" && (
        <div className="admin-detail-grid">
          <Card>
            <h2>Identity &amp; location</h2>
            <dl className="admin-dl">
              <dt>Plate</dt>
              <dd>{detail.plateNumber}</dd>
              <dt>Category</dt>
              <dd>{detail.categoryName}</dd>
              <dt>Home location</dt>
              <dd>{detail.homeLocationName}</dd>
              <dt>Current location</dt>
              <dd>{detail.currentLocationName}</dd>
              <dt>Status</dt>
              <dd><StatusBadge variant={detail.status as StatusBadgeVariant} /></dd>
            </dl>
          </Card>

          <Card>
            <h2>Images</h2>
            {detail.images.length === 0 ? (
              <p>No images yet.</p>
            ) : (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {detail.images.map((img, index) => (
                  <div key={img.id} style={{ textAlign: "center" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt="" style={{ width: 120, height: 80, objectFit: "cover", borderRadius: 4 }} />
                    {index === 0 && <div><small>Primary</small></div>}
                    {canEdit && (
                      <div style={{ display: "flex", gap: 4, justifyContent: "center", marginTop: 4 }}>
                        {index !== 0 && (
                          <form action={setPrimaryImageAction}>
                            <input type="hidden" name="vehicleId" value={id} />
                            <input type="hidden" name="imageId" value={img.id} />
                            <button type="submit" className="outline-button">Make primary</button>
                          </form>
                        )}
                        <form action={removeVehicleImageAction}>
                          <input type="hidden" name="vehicleId" value={id} />
                          <input type="hidden" name="imageId" value={img.id} />
                          <button type="submit" className="outline-button">Remove</button>
                        </form>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && (
              <form action={addVehicleImageAction} style={{ marginTop: 16 }}>
                <input type="hidden" name="vehicleId" value={id} />
                <div className="admin-field">
                  <label htmlFor="url">Image URL</label>
                  <input id="url" name="url" placeholder="https://…" required />
                </div>
                <button type="submit" className="outline-button">Add image</button>
              </form>
            )}
          </Card>

          {canEdit && (
            <Card>
              <h2>Listing</h2>
              <form action={setBookableOnlineAction}>
                <input type="hidden" name="vehicleId" value={id} />
                <input type="hidden" name="value" value={(!detail.isBookableOnline).toString()} />
                <button type="submit" className="outline-button">
                  {detail.isBookableOnline ? "Take off the website" : "List on the website"}
                </button>
              </form>

              {!detail.archivedAt && (
                <form action={archiveVehicleAction} style={{ marginTop: 12 }}>
                  <input type="hidden" name="vehicleId" value={id} />
                  <button type="submit" className="outline-button">Archive vehicle</button>
                </form>
              )}
            </Card>
          )}
        </div>
      )}

      {tab === "pricing" && (
        <Card>
          <h2>Pricing</h2>
          {canEdit ? (
            <form action={updateVehicleAction}>
              <input type="hidden" name="vehicleId" value={id} />
              <div className="admin-field">
                <label htmlFor="dailyRate">Daily rate</label>
                <input id="dailyRate" name="dailyRate" defaultValue={minorToDecimalString(detail.dailyRate)} required />
              </div>
              <div className="admin-field">
                <label htmlFor="weeklyRate">Weekly rate (total, optional)</label>
                <input id="weeklyRate" name="weeklyRate" defaultValue={detail.weeklyRate !== null ? minorToDecimalString(detail.weeklyRate) : ""} />
              </div>
              <div className="admin-field">
                <label htmlFor="monthlyRate">Monthly rate (total, optional)</label>
                <input id="monthlyRate" name="monthlyRate" defaultValue={detail.monthlyRate !== null ? minorToDecimalString(detail.monthlyRate) : ""} />
              </div>
              <div className="admin-field">
                <label htmlFor="securityDeposit">Security deposit</label>
                <input id="securityDeposit" name="securityDeposit" defaultValue={minorToDecimalString(detail.securityDeposit)} required />
              </div>
              <div className="admin-field">
                <label htmlFor="includedKmPerDay">Included km/day (optional)</label>
                <input id="includedKmPerDay" name="includedKmPerDay" type="number" min={0} defaultValue={detail.includedKmPerDay ?? ""} />
              </div>
              <div className="admin-field">
                <label htmlFor="extraKmRate">Extra km rate (optional)</label>
                <input id="extraKmRate" name="extraKmRate" defaultValue={detail.extraKmRate !== null ? minorToDecimalString(detail.extraKmRate) : ""} />
              </div>
              <div className="admin-field">
                <label htmlFor="minRentalDays">Minimum rental days</label>
                <input id="minRentalDays" name="minRentalDays" type="number" min={1} defaultValue={detail.minRentalDays} required />
              </div>
              <div className="admin-field">
                <label htmlFor="maxRentalDays">Maximum rental days (optional)</label>
                <input id="maxRentalDays" name="maxRentalDays" type="number" min={1} defaultValue={detail.maxRentalDays ?? ""} />
              </div>
              <div className="admin-field">
                <label htmlFor="minDriverAge">Minimum driver age</label>
                <input id="minDriverAge" name="minDriverAge" type="number" min={16} defaultValue={detail.minDriverAge} required />
              </div>
              <button type="submit" className="admin-primary-button">Save pricing</button>
            </form>
          ) : (
            <dl className="admin-dl">
              <dt>Daily rate</dt>
              <dd>{formatMoney(detail.dailyRate, currency)}</dd>
              <dt>Security deposit</dt>
              <dd>{formatMoney(detail.securityDeposit, currency)}</dd>
            </dl>
          )}
        </Card>
      )}

      {tab === "availability" && (
        <div className="admin-detail-grid">
          <Card>
            <h2>Next 90 days</h2>
            {detail.upcomingBlocks.length === 0 ? (
              <p>No blocks in the next 90 days — fully available.</p>
            ) : (
              <table className="admin-table admin-table-compact">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Reference</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {detail.upcomingBlocks.map((b) => (
                    <tr key={b.id}>
                      <td>{b.blockType}</td>
                      <td>{formatDateTime(b.start)}</td>
                      <td>{formatDateTime(b.end)}</td>
                      <td>{b.bookingReference ?? "—"}</td>
                      {canEdit && (
                        <td>
                          {b.blockType === "MANUAL" && (
                            <form action={removeManualBlockAction}>
                              <input type="hidden" name="vehicleId" value={id} />
                              <input type="hidden" name="blockId" value={b.id} />
                              <button type="submit" className="outline-button">Remove</button>
                            </form>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {canEdit && (
            <Card>
              <h2>Add manual block</h2>
              <p><small>For transfers, detailing, or owner use.</small></p>
              <form action={createManualBlockAction}>
                <input type="hidden" name="vehicleId" value={id} />
                <div className="admin-field">
                  <label htmlFor="start">Start</label>
                  <input id="start" name="start" type="datetime-local" required />
                </div>
                <div className="admin-field">
                  <label htmlFor="end">End</label>
                  <input id="end" name="end" type="datetime-local" required />
                </div>
                <button type="submit" className="outline-button">Add block</button>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "maintenance" && (
        <div className="admin-detail-grid">
          <Card>
            <h2>History</h2>
            {detail.maintenance.length === 0 ? (
              <p>No maintenance recorded.</p>
            ) : (
              <table className="admin-table admin-table-compact">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Scheduled</th>
                    <th>Completed</th>
                    <th>Notes</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {detail.maintenance.map((m) => (
                    <tr key={m.id}>
                      <td>{m.type}</td>
                      <td>{m.status}</td>
                      <td>{formatDateTime(m.scheduledAt)}</td>
                      <td>{m.completedAt ? formatDateTime(m.completedAt) : "—"}</td>
                      <td>{m.notes ?? "—"}</td>
                      {canEdit && (
                        <td>
                          {m.status !== "COMPLETED" && m.status !== "CANCELLED" && (
                            <form action={completeMaintenanceAction}>
                              <input type="hidden" name="vehicleId" value={id} />
                              <input type="hidden" name="maintenanceId" value={m.id} />
                              <button type="submit" className="outline-button">Complete now</button>
                            </form>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {canEdit && (
            <Card>
              <h2>Add maintenance</h2>
              <form action={createMaintenanceAction}>
                <input type="hidden" name="vehicleId" value={id} />
                <div className="admin-field">
                  <label htmlFor="type">Type</label>
                  <select id="type" name="type" required>
                    <option value="SCHEDULED">Scheduled</option>
                    <option value="REPAIR">Repair</option>
                    <option value="INSPECTION">Inspection</option>
                    <option value="CLEANING">Cleaning</option>
                  </select>
                </div>
                <div className="admin-field">
                  <label htmlFor="scheduledAt">Start</label>
                  <input id="scheduledAt" name="scheduledAt" type="datetime-local" defaultValue={toDateTimeLocal(now)} required />
                </div>
                <div className="admin-field">
                  <label htmlFor="endAt">End</label>
                  <input id="endAt" name="endAt" type="datetime-local" required />
                </div>
                <div className="admin-field">
                  <label htmlFor="notes">Notes (optional)</label>
                  <textarea id="notes" name="notes" rows={2} />
                </div>
                <button type="submit" className="outline-button">Add maintenance</button>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "history" && (
        <Card>
          <h2>Rental history</h2>
          <dl className="admin-dl" style={{ marginBottom: 20 }}>
            <dt>Total days rented</dt>
            <dd>{detail.totalDaysRented}</dd>
            <dt>Total revenue</dt>
            <dd>{formatMoney(detail.totalRevenue, currency)}</dd>
          </dl>
          {detail.rentalHistory.length === 0 ? (
            <p>No past bookings.</p>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Pickup</th>
                  <th>Return</th>
                  <th>Days</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.rentalHistory.map((b) => (
                  <tr key={b.id}>
                    <td>{b.reference}</td>
                    <td>{formatDateTime(b.pickupAt)}</td>
                    <td>{formatDateTime(b.returnAt)}</td>
                    <td>{b.rentalDays}</td>
                    <td>{formatMoney(b.totalAmount, b.currency)}</td>
                    <td><StatusBadge variant={b.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}
