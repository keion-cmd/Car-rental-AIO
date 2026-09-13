import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../../lib/auth/guard";
import { PageHeader } from "../../../../components/admin/PageHeader";
import { Card } from "../../../../components/admin/Card";
import { formatMoney } from "../../../../../lib/money";
import { getBookingDetail } from "../../../../../lib/services/booking-query.service";
import { previewCheckIn } from "../../../../../lib/services/booking.service";
import { checkInBookingAction } from "../../../../actions/check-in-out";

export const metadata: Metadata = {
  title: "Check in | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const FUEL_LABELS = ["E", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "F"];

const ERROR_MESSAGES: Record<string, string> = {
  "not-ongoing": "This booking is not ONGOING and cannot be checked in.",
  "already-checked-in": "This booking has already been checked in.",
  "odometer-below-checkout": "The odometer reading entered is below the check-out reading.",
  "invalid-input": "Enter a valid odometer reading and fuel level.",
};

export default async function CheckInPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuth("STAFF");
  const { id } = await params;
  const raw = await searchParams;
  const errorFlag = Array.isArray(raw.error) ? raw.error[0] : raw.error;
  const rawOdometerIn = Array.isArray(raw.odometerIn) ? raw.odometerIn[0] : raw.odometerIn;
  const rawFuelIn = Array.isArray(raw.fuelIn) ? raw.fuelIn[0] : raw.fuelIn;
  const rawDamageNote = Array.isArray(raw.damageNote) ? raw.damageNote[0] : raw.damageNote;

  const detail = await getBookingDetail(id);
  if (!detail) {
    notFound();
  }

  if (detail.status !== "ONGOING") {
    return (
      <>
        <PageHeader
          title={`Check in ${detail.reference}`}
          action={<Link href={`/admin/bookings/${id}`} className="outline-button">← Back to booking</Link>}
        />
        <Card>
          <p>This booking is {detail.status}, not ONGOING. Only a checked-out booking can be checked in.</p>
        </Card>
      </>
    );
  }

  const odometerIn = rawOdometerIn ? Number(rawOdometerIn) : undefined;
  const fuelIn = rawFuelIn ? Number(rawFuelIn) : undefined;
  const hasEntry = odometerIn !== undefined && Number.isInteger(odometerIn) && fuelIn !== undefined && Number.isInteger(fuelIn);

  const preview = hasEntry ? await previewCheckIn(id, { odometerIn: odometerIn!, fuelIn: fuelIn! }) : null;

  return (
    <>
      <PageHeader
        title={`Check in ${detail.reference}`}
        description={`${detail.vehicle.make} ${detail.vehicle.model} · ${detail.vehicle.plateNumber}`}
        action={<Link href={`/admin/bookings/${id}`} className="outline-button">← Back to booking</Link>}
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
        </div>
      )}

      {preview && !preview.ok && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[preview.reason.toLowerCase().replace(/_/g, "-")] ?? "Something went wrong."}</p>
        </div>
      )}

      <Card>
        <h2>Return details</h2>
        <form method="get">
          <div className="admin-field">
            <label htmlFor="odometerIn">Odometer (km)</label>
            <input id="odometerIn" name="odometerIn" type="number" min={detail.odometerOut ?? 0} defaultValue={odometerIn} required />
            <small>Checked out at: {detail.odometerOut ?? "—"} km</small>
          </div>

          <div className="admin-field">
            <label>Fuel level</label>
            <div className="admin-segmented">
              {FUEL_LABELS.map((label, eighths) => (
                <label key={eighths}>
                  <input type="radio" name="fuelIn" value={eighths} defaultChecked={fuelIn === eighths} required />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="admin-field">
            <label htmlFor="damageNote">Damage note (optional)</label>
            <textarea id="damageNote" name="damageNote" rows={2} defaultValue={rawDamageNote} />
          </div>

          <button type="submit" className="outline-button">Review charges</button>
        </form>
      </Card>

      {preview && preview.ok && (
        <div style={{ marginTop: 20 }}>
        <Card className="admin-charge-summary">
          <h2>Extra charges — confirm before check-in</h2>
          <table>
            <tbody>
              {preview.lineItemsAdded.length === 0 && (
                <tr><td>No extra charges.</td></tr>
              )}
              {preview.lineItemsAdded.map((li, i) => (
                <tr key={i}>
                  <td>{li.description}</td>
                  <td>{formatMoney(li.totalAmount, detail.currency)}</td>
                </tr>
              ))}
              <tr>
                <td><strong>New total</strong></td>
                <td><strong>{formatMoney(preview.projectedTotal, detail.currency)}</strong></td>
              </tr>
            </tbody>
          </table>
          {(preview.ratesMissing.lateFee || preview.ratesMissing.fuel) && (
            <p className="admin-gap-note">
              {preview.ratesMissing.lateFee && "This return is beyond the grace period, but no late-fee rate is configured in Settings — no late fee was charged. "}
              {preview.ratesMissing.fuel && "Fuel was returned below the check-out level, but no fuel rate is configured in Settings — no fuel charge was applied."}
            </p>
          )}

          <form action={checkInBookingAction} style={{ marginTop: 16 }}>
            <input type="hidden" name="bookingId" value={detail.id} />
            <input type="hidden" name="odometerIn" value={odometerIn} />
            <input type="hidden" name="fuelIn" value={fuelIn} />
            <input type="hidden" name="damageNote" value={rawDamageNote ?? ""} />
            <button type="submit" className="admin-primary-button">Confirm and check in</button>
          </form>
        </Card>
        </div>
      )}
    </>
  );
}
