"use server";

import { redirect } from "next/navigation";
import { requireAuth } from "../../lib/auth/guard";
import { checkOutBooking, checkInBooking } from "../../lib/services/booking.service";

// Thin "use server" wrappers around lib/services/booking.service.ts, same
// separation as app/actions/bookings.ts: redirect() is a framework signal
// that only makes sense here, business logic stays independently testable.

function toRejectionSlug(reason: string): string {
  return reason.toLowerCase().replace(/_/g, "-");
}

export async function checkOutBookingAction(formData: FormData): Promise<void> {
  const user = await requireAuth("STAFF");

  const bookingId = String(formData.get("bookingId") ?? "");
  const odometerOut = Number(formData.get("odometerOut"));
  const fuelOut = Number(formData.get("fuelOut"));
  const notes = String(formData.get("notes") ?? "");

  if (!bookingId || !Number.isInteger(odometerOut) || !Number.isInteger(fuelOut)) {
    redirect(`/admin/bookings/${bookingId}?error=invalid-input`);
  }

  const outcome = await checkOutBooking(bookingId, { odometerOut, fuelOut, staffUserId: user.id, notes });
  if (!outcome.ok) {
    redirect(`/admin/bookings/${bookingId}/check-out?error=${toRejectionSlug(outcome.reason)}`);
  }

  redirect(`/admin/bookings/${bookingId}`);
}

export async function checkInBookingAction(formData: FormData): Promise<void> {
  const user = await requireAuth("STAFF");

  const bookingId = String(formData.get("bookingId") ?? "");
  const odometerIn = Number(formData.get("odometerIn"));
  const fuelIn = Number(formData.get("fuelIn"));
  const damageNote = String(formData.get("damageNote") ?? "");

  if (!bookingId || !Number.isInteger(odometerIn) || !Number.isInteger(fuelIn)) {
    redirect(`/admin/bookings/${bookingId}?error=invalid-input`);
  }

  const outcome = await checkInBooking(bookingId, { odometerIn, fuelIn, staffUserId: user.id, damageNote });
  if (!outcome.ok) {
    redirect(`/admin/bookings/${bookingId}/check-in?error=${toRejectionSlug(outcome.reason)}`);
  }

  redirect(`/admin/bookings/${bookingId}`);
}
