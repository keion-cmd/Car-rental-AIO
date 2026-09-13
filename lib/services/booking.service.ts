import { PrismaClient, Prisma, BookingStatus, PaymentStatus } from "@prisma/client";
import { priceRequest, getQuote, type PriceRequestRejectionReason } from "./quote.service";
import { computeBlockWindow } from "./availability.service";
import { createBookingInputSchema, validateDriverLicence } from "../validation/booking";
import { encryptField, decryptField } from "../crypto/field-encryption";

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
  | "LICENCE_EXPIRED"
  | "LICENCE_EXPIRES_DURING_RENTAL"
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
  async insertVehicleBlock(tx: Prisma.TransactionClient, vehicleId: string, start: Date, end: Date, bookingId: string) {
    return tx.$executeRaw`
      INSERT INTO vehicle_blocks (vehicle_id, block_type, period, booking_id, updated_at)
      VALUES (${vehicleId}::uuid, 'BOOKING'::"BlockType", tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)'), ${bookingId}::uuid, now())
    `;
  },
  // A HOLD block from the quote this booking is converting already occupies
  // the exclusion constraint's slot for (vehicle_id, period) — inserting a
  // second BOOKING block for the same window would be rejected by the
  // vehicle's own hold. Converting the existing row in place avoids that.
  // quote_id is cleared: if left set, deleting the (now-consumed) quote
  // later would cascade-delete this booking's block.
  async convertHoldToBooking(tx: Prisma.TransactionClient, quoteId: string, bookingId: string) {
    return tx.vehicleBlock.updateMany({
      where: { quoteId, blockType: "HOLD" },
      data: { blockType: "BOOKING", bookingId, quoteId: null },
    });
  },
};

// The per-year sequence is race-free: pg_advisory_xact_lock scopes to this
// transaction and is released automatically on commit/rollback, so
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

export interface CreateBookingOptions {
  // No client passed: createBooking opens and owns its own transaction, as
  // before. Client passed: it joins the caller's transaction rather than
  // opening a nested one — Prisma's nested $transaction does not behave as
  // most people expect, so the joining path is explicit here, not accidental.
  // This is what lets findOrCreateCustomer + createBooking commit atomically.
  tx?: Prisma.TransactionClient;
  // Defaults to the real clock. Passed through to priceRequest and
  // validateDriverLicence so licence-expiry/age logic is testable with a
  // frozen clock instead of only the real one.
  now?: Date;
}

export async function createBooking(rawInput: unknown, options?: CreateBookingOptions): Promise<CreateBookingOutcome> {
  const parsed = createBookingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, reason: "VALIDATION_ERROR" };
  }
  const input = parsed.data;
  const now = options?.now ?? new Date();

  const licenceCheck = validateDriverLicence(input, now);
  if (!licenceCheck.ok) {
    return { ok: false, reason: licenceCheck.reason };
  }

  if (input.quoteId) {
    const quoteRecord = await getQuote(input.quoteId);
    if (!quoteRecord || quoteRecord.isExpired) {
      return { ok: false, reason: "QUOTE_EXPIRED" };
    }
  }

  const runInTransaction = async (tx: Prisma.TransactionClient): Promise<CreateBookingOutcome> => {
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

    const reference = await nextReference(tx, now);

    const booking = await bookingSteps.insertBooking(tx, {
      reference,
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
      driverFullName: input.driverFullName,
      driverPhone: input.driverPhone,
      driverEmail: input.driverEmail,
      driverLicenceCountry: input.driverLicenceCountry,
      driverLicenceExpiry: input.driverLicenceExpiry,
      // Encrypted here, at the service layer, so the call site is
      // greppable — see lib/crypto/field-encryption.ts. Never stored or
      // logged in plaintext.
      driverLicenceNumber: encryptField(input.driverLicenceNumber),
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

    // If this booking is converting a live quote hold, reuse that block
    // row rather than inserting a second one — the exclusion constraint
    // would reject its own customer's hold. Otherwise (no quote, or the
    // hold already expired/was released) insert fresh: if the vehicle is
    // already blocked for this window, Postgres raises 23P01 here and the
    // catch below turns it into VEHICLE_UNAVAILABLE. Everything written
    // above in this transaction (booking, line items) rolls back with it.
    let converted = false;
    if (input.quoteId) {
      const updateResult = await bookingSteps.convertHoldToBooking(tx, input.quoteId, booking.id);
      converted = updateResult.count > 0;
    }
    if (!converted) {
      const { start, end } = await computeBlockWindow(tx, input.pickupLocationId, input.pickupAt, input.returnAt);
      await bookingSteps.insertVehicleBlock(tx, input.vehicleId, start, end, booking.id);
    }

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
  };

  try {
    if (options?.tx) {
      return await runInTransaction(options.tx);
    }
    return await prisma.$transaction(runInTransaction);
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "VEHICLE_UNAVAILABLE" };
    }
    throw err;
  }
}

export type CancelBookingOutcome = { ok: true } | { ok: false; reason: "BOOKING_NOT_FOUND" | "ALREADY_CANCELLED" };

export async function cancelBooking(bookingId: string, reason: string): Promise<CancelBookingOutcome> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      return { ok: false, reason: "BOOKING_NOT_FOUND" };
    }
    if (booking.status === BookingStatus.CANCELLED) {
      return { ok: false, reason: "ALREADY_CANCELLED" };
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED, cancellationReason: reason, cancelledAt: new Date() },
    });

    // Found by the bookingId FK, not by recomputing the period — correct
    // even if the pickup Location's buffer settings changed since creation.
    await tx.vehicleBlock.deleteMany({ where: { bookingId } });

    return { ok: true };
  });
}

export async function getBookingByReference(reference: string) {
  // driverLicenceNumber is identity-document data — never returned by a
  // public-facing read path, encrypted or not. getDriverLicenceNumber below
  // is the only function that reads it. vehicle/lineItems are included so
  // the confirmation page can render the full breakdown without a second
  // write path or query into bookings.
  return prisma.booking.findUnique({
    where: { reference },
    omit: { driverLicenceNumber: true },
    include: {
      lineItems: { orderBy: { sortOrder: "asc" } },
      vehicle: { include: { model: { include: { category: true } } } },
    },
  });
}

// The ONLY function that decrypts driverLicenceNumber. Kept separate from
// every other read path so every call site that needs the plaintext is
// greppable and auditable.
export async function getDriverLicenceNumber(bookingId: string): Promise<string> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { driverLicenceNumber: true },
  });
  return decryptField(booking.driverLicenceNumber);
}
