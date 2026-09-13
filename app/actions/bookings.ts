"use server";

import { redirect } from "next/navigation";
import { requireAuth } from "../../lib/auth/guard";
import { cancelBooking, updateStaffNotes } from "../../lib/services/booking.service";

// The only write path this screen uses. Cancelling requires MANAGER — STAFF
// may view the bookings list/detail but not act on it. requireAuth redirects
// to /admin/login when there is no session at all; an authenticated STAFF
// session that lacks MANAGER also fails requireAuth's role check and is
// redirected the same way, since there is no "logged in but forbidden" page
// in this admin shell (see lib/auth/guard.ts).
export async function cancelBookingAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");

  const bookingId = String(formData.get("bookingId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (!bookingId || !reason) {
    redirect(`/admin/bookings/${bookingId}?error=missing-reason`);
  }

  const outcome = await cancelBooking(bookingId, reason);
  if (!outcome.ok) {
    redirect(`/admin/bookings/${bookingId}?error=${outcome.reason.toLowerCase().replace(/_/g, "-")}`);
  }

  redirect(`/admin/bookings/${bookingId}`);
}

// staffNotes is internal-only — MANAGER may edit it from the booking detail
// page. This is the only screen that writes it directly (check-out/check-in
// also write it, via booking.service's own append path).
export async function updateStaffNotesAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");

  const bookingId = String(formData.get("bookingId") ?? "");
  const notes = String(formData.get("notes") ?? "");

  if (!bookingId) {
    redirect(`/admin/bookings/${bookingId}`);
  }

  await updateStaffNotes(bookingId, notes);
  redirect(`/admin/bookings/${bookingId}`);
}
