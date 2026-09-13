import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, roleSatisfies } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { Card } from "../../../components/admin/Card";
import { StatusBadge } from "../../../components/admin/StatusBadge";
import { formatMoney } from "../../../../lib/money";
import { getBookingDetail } from "../../../../lib/services/booking-query.service";
import { cancelBookingAction } from "../../../actions/bookings";

export const metadata: Metadata = {
  title: "Booking detail | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-PH", { timeZone, dateStyle: "full", timeStyle: "short" }).format(date);
}

function formatDate(date: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-PH", { timeZone, dateStyle: "long" }).format(date);
}

const ERROR_MESSAGES: Record<string, string> = {
  "missing-reason": "A cancellation reason is required.",
  "booking-not-found": "That booking no longer exists.",
  "already-cancelled": "This booking is already cancelled.",
};

export default async function AdminBookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth("STAFF");
  const { id } = await params;
  const raw = await searchParams;
  const errorFlag = Array.isArray(raw.error) ? raw.error[0] : raw.error;

  const detail = await getBookingDetail(id);
  if (!detail) {
    notFound();
  }

  const canCancel = roleSatisfies(user.role, "MANAGER") && detail.status !== "CANCELLED";
  const pickupTz = detail.pickupLocation?.timezone ?? "UTC";

  // The primary action always reflects the next legal transition — CONFIRMED
  // -> check out, ONGOING -> check in, otherwise no counter action applies.
  const primaryAction =
    detail.status === "CONFIRMED" ? (
      <Link href={`/admin/bookings/${id}/check-out`} className="admin-primary-button" style={{ textDecoration: "none", display: "inline-block" }}>
        Check out
      </Link>
    ) : detail.status === "ONGOING" ? (
      <Link href={`/admin/bookings/${id}/check-in`} className="admin-primary-button" style={{ textDecoration: "none", display: "inline-block" }}>
        Check in
      </Link>
    ) : null;

  return (
    <>
      <PageHeader
        title={`Booking ${detail.reference}`}
        description={`Booked ${formatDate(detail.createdAt)} via ${detail.source}.`}
        action={
          <>
            {primaryAction}
            <Link href="/admin/bookings" className="outline-button" style={{ marginLeft: 10 }}>← Back to bookings</Link>
          </>
        }
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
        </div>
      )}

      <Card className="admin-status-header">
        <StatusBadge variant={detail.status} />
        <StatusBadge variant={detail.paymentStatus} />
        {detail.needsAttention && <span className="admin-flag admin-flag-attention">Needs attention</span>}
        {detail.isOverdue && <span className="admin-flag admin-flag-overdue">Overdue</span>}
        {detail.isStartingToday && <span className="admin-flag admin-flag-today">Pickup today</span>}
        {detail.isReturningToday && <span className="admin-flag admin-flag-today">Return today</span>}
      </Card>

      <div className="admin-detail-grid">
        <Card>
          <h2>Rental</h2>
          <dl className="admin-dl">
            <dt>Vehicle</dt>
            <dd>{detail.vehicle.make} {detail.vehicle.model} · {detail.vehicle.plateNumber}</dd>
            <dt>Pickup</dt>
            <dd>{formatDateTime(detail.pickupAt, pickupTz)}<br /><small>{detail.pickupLocation?.name ?? "Unknown location"}</small></dd>
            <dt>Return</dt>
            <dd>{formatDateTime(detail.returnAt, pickupTz)}<br /><small>{detail.dropoffLocation?.name ?? "Unknown location"}</small></dd>
            <dt>Rental days</dt>
            <dd>{detail.rentalDays}</dd>
          </dl>
        </Card>

        <Card>
          <h2>Customer</h2>
          <dl className="admin-dl">
            <dt>Name</dt>
            <dd>{detail.customer.name}</dd>
            <dt>Email</dt>
            <dd>{detail.customer.email}</dd>
            <dt>Phone</dt>
            <dd>{detail.customer.phone ?? "—"}</dd>
          </dl>
        </Card>

        <Card>
          <h2>Driver of record</h2>
          <dl className="admin-dl">
            <dt>Name</dt>
            <dd>{detail.driver.fullName}</dd>
            <dt>Email</dt>
            <dd>{detail.driver.email}</dd>
            <dt>Phone</dt>
            <dd>{detail.driver.phone}</dd>
            <dt>Licence</dt>
            {/* The licence NUMBER is never fetched or displayed here — see
                getDriverLicenceNumber in booking.service.ts for the one
                counter-facing read path, out of scope for this phase. */}
            <dd>{detail.driver.licenceCountry}, expires {formatDate(detail.driver.licenceExpiry)}</dd>
          </dl>
        </Card>

        <Card>
          <h2>Price breakdown</h2>
          <table className="admin-table admin-table-compact">
            <tbody>
              {detail.lineItems.map((li) => (
                <tr key={li.id}>
                  <td>{li.description}{li.quantity > 1 ? ` ×${li.quantity}` : ""}</td>
                  <td>{formatMoney(li.totalAmount, detail.currency)}</td>
                </tr>
              ))}
              <tr>
                <td>Subtotal</td>
                <td>{formatMoney(detail.subtotalAmount, detail.currency)}</td>
              </tr>
              <tr>
                <td>Tax</td>
                <td>{formatMoney(detail.taxAmount, detail.currency)}</td>
              </tr>
              <tr>
                <td><strong>Total</strong></td>
                <td><strong>{formatMoney(detail.totalAmount, detail.currency)}</strong></td>
              </tr>
              <tr>
                <td>Security deposit <small>(refundable)</small></td>
                <td>{formatMoney(detail.securityDeposit, detail.currency)}</td>
              </tr>
              <tr>
                <td>Balance due</td>
                <td>{detail.balanceDue === null ? "Partially paid — amount not tracked" : formatMoney(detail.balanceDue, detail.currency)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        {(detail.checkedOutAt || detail.checkedInAt) && (
          <Card>
            <h2>Handover record</h2>
            <dl className="admin-dl">
              {detail.checkedOutAt && (
                <>
                  <dt>Checked out</dt>
                  <dd>{formatDateTime(detail.checkedOutAt, pickupTz)}<br /><small>Odometer {detail.odometerOut} km · Fuel {detail.fuelOut}/8</small></dd>
                </>
              )}
              {detail.checkedInAt && (
                <>
                  <dt>Checked in</dt>
                  <dd>{formatDateTime(detail.checkedInAt, pickupTz)}<br /><small>Odometer {detail.odometerIn} km · Fuel {detail.fuelIn}/8</small></dd>
                </>
              )}
            </dl>
          </Card>
        )}

        {detail.cancellationReason && (
          <Card>
            <h2>Cancellation</h2>
            <p>{detail.cancellationReason}</p>
            {detail.cancelledAt && <p><small>Cancelled {formatDate(detail.cancelledAt)}</small></p>}
          </Card>
        )}

        {canCancel && (
          <Card>
            <h2>Cancel booking</h2>
            <form action={cancelBookingAction}>
              <input type="hidden" name="bookingId" value={detail.id} />
              <textarea name="reason" placeholder="Reason for cancellation" required rows={3} style={{ width: "100%" }} />
              <button type="submit" className="outline-button" style={{ marginTop: 10 }}>Cancel booking</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
