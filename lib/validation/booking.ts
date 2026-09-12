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
  })
  .strict();

export type CreateBookingInputPayload = z.infer<typeof createBookingInputSchema>;

export const cancelBookingInputSchema = z
  .object({
    bookingId: z.string().uuid(),
    reason: z.string().min(1),
  })
  .strict();

export type CancelBookingInputPayload = z.infer<typeof cancelBookingInputSchema>;
