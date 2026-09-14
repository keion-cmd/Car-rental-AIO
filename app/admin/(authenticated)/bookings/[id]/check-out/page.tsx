import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../../../lib/auth/guard";
import { PageHeader } from "../../../../../components/admin/PageHeader";
import { Card } from "../../../../../components/admin/Card";
import { getBookingDetail } from "../../../../../../lib/services/booking-query.service";
import { getVehicleCurrentOdometer } from "../../../../../../lib/services/booking.service";
import { prisma } from "../../../../../../lib/services/booking-query.service";
import { checkOutBookingAction } from "../../../../../actions/check-in-out";

export const metadata: Metadata = {
  title: "Check out | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const FUEL_LABELS = ["E", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "F"];

const ERROR_MESSAGES: Record<string, string> = {
  "not-confirmed": "This booking is not CONFIRMED and cannot be checked out.",
  "already-checked-out": "This booking has already been checked out.",
  "odometer-below-vehicle-reading": "The odometer reading entered is below the vehicle's last recorded reading.",
  "invalid-input": "Enter a valid odometer reading and fuel level.",
};

export default async function CheckOutPage({
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

  const detail = await getBookingDetail(id);
  if (!detail) {
    notFound();
  }

  const currentOdometer = await getVehicleCurrentOdometer(prisma, detail.vehicle.id);

  return (
    <>
      <PageHeader
        title={`Check out ${detail.reference}`}
        description={`${detail.vehicle.make} ${detail.vehicle.model} · ${detail.vehicle.plateNumber}`}
        action={<Link href={`/admin/bookings/${id}`} className="outline-button">← Back to booking</Link>}
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
        </div>
      )}

      {detail.status !== "CONFIRMED" ? (
        <Card>
          <p>This booking is {detail.status}, not CONFIRMED. Only a confirmed booking can be checked out.</p>
        </Card>
      ) : (
        <Card>
          <h2>Confirm handover</h2>
          <dl className="admin-dl" style={{ marginBottom: 20 }}>
            <dt>Customer</dt>
            <dd>{detail.customer.name}</dd>
            <dt>Vehicle</dt>
            <dd>{detail.vehicle.make} {detail.vehicle.model} · {detail.vehicle.plateNumber}</dd>
          </dl>

          <form action={checkOutBookingAction}>
            <input type="hidden" name="bookingId" value={detail.id} />

            <div className="admin-field">
              <label htmlFor="odometerOut">Odometer (km)</label>
              <input
                id="odometerOut"
                name="odometerOut"
                type="number"
                min={currentOdometer}
                defaultValue={currentOdometer}
                required
              />
              <small>Last recorded reading: {currentOdometer} km</small>
            </div>

            <div className="admin-field">
              <label>Fuel level</label>
              <div className="admin-segmented">
                {FUEL_LABELS.map((label, eighths) => (
                  <label key={eighths}>
                    <input type="radio" name="fuelOut" value={eighths} defaultChecked={eighths === 8} required />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="admin-field">
              <label htmlFor="notes">Condition note (optional)</label>
              <textarea id="notes" name="notes" rows={2} />
            </div>

            <button type="submit" className="admin-primary-button">Check out</button>
          </form>
        </Card>
      )}
    </>
  );
}
