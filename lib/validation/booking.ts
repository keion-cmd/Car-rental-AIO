import { z } from "zod";

// Price authority lives in the pricing engine, never the caller. This
// schema is intentionally strict (rejects unknown keys) so that a caller
// sending totalAmount, price, subtotal, or any other money field gets a
// validation error, not a silently-ignored field.
export const createBookingInputSchema = z
  .object({
    customerId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    pickupLocationId: z.string().uuid(),
    dropoffLocationId: z.string().uuid(),
    pickupAt: z.date(),
    returnAt: z.date(),
    driverDateOfBirth: z.date(),
    quoteId: z.string().uuid().optional(),
    source: z.enum(["WEBSITE", "PHONE", "WALK_IN", "PARTNER"]).optional(),
    // The driver of record, snapshotted onto the booking — see the comment
    // on Booking.driverLicenceNumber in prisma/schema.prisma. Licence
    // expiry-vs-time validation is NOT done here (see validateDriverLicence
    // below): a Zod schema is a static singleton, and baking "now" into it
    // would mean either the system clock at import time or the system
    // clock at parse time — neither is the explicit, passed-in `now` this
    // project uses for testable time-based rules elsewhere (see quote()).
    driverFullName: z.string().min(1),
    driverPhone: z.string().min(1),
    driverEmail: z.string().email(),
    driverLicenceNumber: z.string().min(1),
    driverLicenceCountry: z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code, e.g. \"PH\""),
    driverLicenceExpiry: z.date(),
  })
  .strict();

export type CreateBookingInputPayload = z.infer<typeof createBookingInputSchema>;

export type DriverLicenceRejectionReason = "LICENCE_EXPIRED" | "LICENCE_EXPIRES_DURING_RENTAL";

export type DriverLicenceValidationOutcome = { ok: true } | { ok: false; reason: DriverLicenceRejectionReason };

// Pure function, explicit `now` — never reads the system clock itself, so
// callers (and tests) control what "today" means for this check.
export function validateDriverLicence(
  input: { driverLicenceExpiry: Date; returnAt: Date },
  now: Date
): DriverLicenceValidationOutcome {
  if (input.driverLicenceExpiry.getTime() <= now.getTime()) {
    return { ok: false, reason: "LICENCE_EXPIRED" };
  }
  if (input.driverLicenceExpiry.getTime() < input.returnAt.getTime()) {
    return { ok: false, reason: "LICENCE_EXPIRES_DURING_RENTAL" };
  }
  return { ok: true };
}

export const cancelBookingInputSchema = z
  .object({
    bookingId: z.string().uuid(),
    reason: z.string().min(1),
  })
  .strict();

export type CancelBookingInputPayload = z.infer<typeof cancelBookingInputSchema>;
