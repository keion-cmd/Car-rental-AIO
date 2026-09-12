import { PrismaClient, Prisma, BookingStatus, PaymentStatus } from "@prisma/client";
import { priceRequest, getQuote, type PriceRequestRejectionReason } from "./quote.service";
import { computeBlockWindow } from "./availability.service";
import { createBookingInputSchema } from "../validation/booking";

// This is the ONLY function that creates a booking. It re-prices
// server-side inside a single transaction, writes the booking, its line
// items, and the vehicle_blocks row together, and treats Postgres 23P01
// (exclusion_violation) as an expected outcome rather than a bug.

export const prisma = new PrismaClient();

const EXCLUSION_VIOLATION_CODE = "23P01";

export type BookingRejectionReason =
  | "VALIDATION_ERROR"
  | "VEHICLE_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "PRICE_UNAVAILABLE"
  | PriceRequestRejectionReason;

export interface CreateBookingResult {
  ok: true;
  bookingId: string;
  reference: string;
  totalAmount: bigint;
  subtotalAmount: bigint;
  taxAmount: bigint;
  securityDeposit: bigint;
  currency: string;
  rentalDays: number;
}

export type CreateBookingOutcome = CreateBookingResult | { ok: false; reason: BookingRejectionReason };

function isExclusionViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2010" &&
    typeof err.meta?.code === "string" &&
    err.meta.code === EXCLUSION_VIOLATION_CODE
  );
}

// Grouped as an object (not free functions) so tests can inject a REAL
// failure at a specific point inside the transaction via
// vi.spyOn(bookingSteps, "insertVehicleBlock").mockRejectedValueOnce(...)
// and prove atomicity — the rollback that follows is genuine Postgres
// behaviour, not a simulated one.
export const bookingSteps = {
  async insertBooking(tx: Prisma.TransactionClient, data: Prisma.BookingUncheckedCreateInput) {
    return tx.booking.create({ data });
  },
  async insertLineItems(tx: Prisma.TransactionClient, data: Prisma.BookingLineItemCreateManyInput[]) {
    return tx.bookingLineItem.createMany({ data });
  },
  async insertVehicleBlock(tx: Prisma.TransactionClient, vehicleId: string, start: Date, end: Date) {
    return tx.$executeRaw`
      INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
      VALUES (${vehicleId}::uuid, 'BOOKING'::"BlockType", tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)'), now())
    `;
  },
};

// bookings has no `reference` column (checked against prisma/schema.prisma)
// and no schema change is permitted this phase, so the BK-YYYY-NNNN
// reference is generated here and returned to the caller but NOT
// persisted — it cannot currently be looked up again after creation. The
// per-year sequence is still race-free: pg_advisory_xact_lock scopes to
// this transaction and is released automatically on commit/rollback, so
// concurrent transactions serialise on the same year's counter.
async function nextReference(tx: Prisma.TransactionClient, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"booking_ref_" + year}))`;
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bookings
    WHERE EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC') = ${year}
  `;
  const nextNumber = Number(rows[0]?.count ?? BigInt(0)) + 1;
  return `BK-${year}-${String(nextNumber).padStart(4, "0")}`;
}

export async function createBooking(rawInput: unknown): Promise<CreateBookingOutcome> {
  const parsed = createBookingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, reason: "VALIDATION_ERROR" };
  }
  const input = parsed.data;
  const now = new Date();

  if (input.quoteId) {
    const quoteRecord = await getQuote(input.quoteId);
    if (!quoteRecord || quoteRecord.isExpired) {
      return { ok: false, reason: "QUOTE_EXPIRED" };
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Price authority: always re-computed here from current vehicle
      // rates. The caller's quoteId (if any) is used only for the expiry
      // check above — its stored price is never read or trusted.
      const priced = await priceRequest(tx, {
        vehicleId: input.vehicleId,
        pickupLocationId: input.pickupLocationId,
        returnLocationId: input.dropoffLocationId,
        pickupAt: input.pickupAt,
        returnAt: input.returnAt,
        driverDateOfBirth: input.driverDateOfBirth,
        now,
      });

      if (!priced.ok) {
        const reason: BookingRejectionReason = priced.reason === "VEHICLE_NOT_PRICED" ? "PRICE_UNAVAILABLE" : priced.reason;
        return { ok: false, reason };
      }

      const booking = await bookingSteps.insertBooking(tx, {
        customerId: input.customerId,
        vehicleId: input.vehicleId,
        pickupLocationId: input.pickupLocationId,
        dropoffLocationId: input.dropoffLocationId,
        pickupAt: input.pickupAt,
        returnAt: input.returnAt,
        subtotalAmount: priced.subtotalAmount,
        taxAmount: priced.taxAmount,
        securityDeposit: priced.securityDeposit,
        rentalDays: priced.rentalDays,
        totalAmount: priced.totalAmount,
        currency: priced.currency,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        source: input.source ?? "WEBSITE",
      });

      await bookingSteps.insertLineItems(
        tx,
        priced.lineItems.map((li) => ({
          bookingId: booking.id,
          type: li.type,
          description: li.description,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
          totalAmount: li.totalAmount,
          isTaxable: li.isTaxable,
          sortOrder: li.sortOrder,
          currency: priced.currency,
        }))
      );

      // Raw insert last: if the vehicle is already blocked for this window,
      // Postgres raises 23P01 here and the catch below turns it into
      // VEHICLE_UNAVAILABLE. Everything written above in this transaction
      // (booking, line items) rolls back with it.
      const { start, end } = await computeBlockWindow(tx, input.pickupLocationId, input.pickupAt, input.returnAt);
      await bookingSteps.insertVehicleBlock(tx, input.vehicleId, start, end);

      const reference = await nextReference(tx, now);

      const result: CreateBookingResult = {
        ok: true,
        bookingId: booking.id,
        reference,
        totalAmount: booking.totalAmount,
        subtotalAmount: booking.subtotalAmount,
        taxAmount: booking.taxAmount,
        securityDeposit: booking.securityDeposit,
        currency: booking.currency,
        rentalDays: booking.rentalDays,
      };
      return result;
    });
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "VEHICLE_UNAVAILABLE" };
    }
    throw err;
  }
}

export type CancelBookingOutcome = { ok: true } | { ok: false; reason: "BOOKING_NOT_FOUND" | "ALREADY_CANCELLED" };

export async function cancelBooking(bookingId: string, reason: string): Promise<CancelBookingOutcome> {
  // `reason` has nowhere to persist: bookings has no cancellation-reason
  // column and no schema change is permitted this phase. Accepted for a
  // stable call signature; not stored. Deferred — flag to the schema owner.
  void reason;

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      return { ok: false, reason: "BOOKING_NOT_FOUND" };
    }
    if (booking.status === BookingStatus.CANCELLED) {
      return { ok: false, reason: "ALREADY_CANCELLED" };
    }

    await tx.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.CANCELLED } });

    // vehicle_blocks has no bookingId column, so the row is matched by
    // recomputing the exact period it was created with (same vehicle,
    // block_type, and window). If Location.prepMinutes/turnaroundMinutes
    // changed between booking and cancellation, this recomputed window
    // could miss the row — deferred, would need a bookingId FK on
    // vehicle_blocks to fix properly.
    const { start, end } = await computeBlockWindow(tx, booking.pickupLocationId, booking.pickupAt, booking.returnAt);
    await tx.$executeRaw`
      DELETE FROM vehicle_blocks
      WHERE vehicle_id = ${booking.vehicleId}::uuid
      AND block_type = 'BOOKING'::"BlockType"
      AND period = tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
    `;

    return { ok: true };
  });
}
