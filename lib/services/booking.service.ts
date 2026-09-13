import { PrismaClient, Prisma, BookingStatus, PaymentStatus } from "@prisma/client";
import { priceRequest, getQuote, type PriceRequestRejectionReason } from "./quote.service";
import { computeBlockWindow } from "./availability.service";
import { createBookingInputSchema, validateDriverLicence } from "../validation/booking";
import { encryptField, decryptField } from "../crypto/field-encryption";
import { multiplyByQty, applyBasisPoints } from "../money";

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

// ==================== COUNTER CHECK-OUT / CHECK-IN (P5-P2) ====================
//
// There is no Vehicle.odometer column — that field is on the pre-authorised
// list for Booking only, not Vehicle. The vehicle's "current" reading is
// derived here from its own most recent checked-out/checked-in booking
// instead of a denormalized duplicate column. A vehicle that has never been
// checked out reads as 0.
export async function getVehicleCurrentOdometer(db: Prisma.TransactionClient | PrismaClient, vehicleId: string): Promise<number> {
  const latest = await db.booking.findFirst({
    where: { vehicleId, checkedOutAt: { not: null } },
    orderBy: { checkedOutAt: "desc" },
    select: { status: true, odometerOut: true, odometerIn: true },
  });
  if (!latest) return 0;
  if (latest.status === "COMPLETED") return latest.odometerIn ?? latest.odometerOut ?? 0;
  return latest.odometerOut ?? 0;
}

export type CheckOutRejectionReason = "NOT_CONFIRMED" | "ALREADY_CHECKED_OUT" | "ODOMETER_BELOW_VEHICLE_READING";

export interface CheckOutInput {
  odometerOut: number;
  fuelOut: number; // eighths of a tank, 0-8
  staffUserId: string;
  // Accepted for interface parity with the spec but NOT persisted — Booking
  // has no notes column, and this schema deliberately does not carry one
  // (see the internalNotes comment in booking-query.service.ts). Adding one
  // is outside the pre-authorised schema change for this phase.
  notes?: string;
}

export interface CheckOutOptions {
  tx?: Prisma.TransactionClient;
  now?: Date;
}

export type CheckOutOutcome = { ok: true; bookingId: string } | { ok: false; reason: CheckOutRejectionReason };

export async function checkOutBooking(
  bookingId: string,
  input: CheckOutInput,
  options?: CheckOutOptions
): Promise<CheckOutOutcome> {
  const now = options?.now ?? new Date();

  const run = async (tx: Prisma.TransactionClient): Promise<CheckOutOutcome> => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.status === "PENDING" || booking.status === "CANCELLED") {
      return { ok: false, reason: "NOT_CONFIRMED" };
    }
    if (booking.status === "ONGOING" || booking.status === "COMPLETED") {
      return { ok: false, reason: "ALREADY_CHECKED_OUT" };
    }

    const currentOdometer = await getVehicleCurrentOdometer(tx, booking.vehicleId);
    if (input.odometerOut < currentOdometer) {
      return { ok: false, reason: "ODOMETER_BELOW_VEHICLE_READING" };
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.ONGOING,
        odometerOut: input.odometerOut,
        fuelOut: input.fuelOut,
        checkedOutAt: now,
        checkedOutById: input.staffUserId,
      },
    });

    return { ok: true, bookingId };
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return prisma.$transaction(run);
}

export type CheckInRejectionReason = "NOT_ONGOING" | "ALREADY_CHECKED_IN" | "ODOMETER_BELOW_CHECKOUT";

export interface CheckInInput {
  odometerIn: number;
  fuelIn: number; // eighths of a tank, 0-8
  staffUserId: string;
  // Accepted for interface parity with the spec but NOT persisted — see the
  // matching comment on CheckOutInput.notes.
  notes?: string;
  damageNote?: string;
}

export interface CheckInOptions {
  tx?: Prisma.TransactionClient;
  now?: Date;
}

export interface CheckInLineItemResult {
  type: "EXTRA_CHARGE";
  description: string;
  totalAmount: bigint;
}

export interface CheckInRatesMissing {
  // true when the corresponding charge would have applied but no rate
  // exists in Settings to price it, per instruction: do not invent a rate.
  lateFee: boolean;
  fuel: boolean;
}

export interface CheckInResult {
  ok: true;
  bookingId: string;
  totalAmount: bigint;
  lineItemsAdded: CheckInLineItemResult[];
  ratesMissing: CheckInRatesMissing;
}

export type CheckInOutcome = CheckInResult | { ok: false; reason: CheckInRejectionReason };

// Pure charge computation shared by the real (writing) checkInBooking below
// and previewCheckIn (read-only, for the confirmation screen the customer
// sees before anything is charged). Takes plain values, not a tx/db handle,
// so both call sites can populate it from whichever query shape they have.
function computeExtraCharges(params: {
  bookingId: string;
  currency: string;
  rentalDays: number;
  returnAt: Date;
  odometerOut: number | null;
  fuelOut: number | null;
  odometerIn: number;
  now: Date;
  billingGraceMinutes: number;
  includedKmPerDay: number | null;
  extraKmRate: bigint | null;
}): { newLineItems: Prisma.BookingLineItemCreateManyInput[]; lineItemsAdded: CheckInLineItemResult[]; ratesMissing: CheckInRatesMissing } {
  const isLate = params.now.getTime() > params.returnAt.getTime() + params.billingGraceMinutes * 60_000;
  const fuelShort = false; // computed by caller, which has fuelIn; see below

  const newLineItems: Prisma.BookingLineItemCreateManyInput[] = [];
  const lineItemsAdded: CheckInLineItemResult[] = [];

  if (params.odometerOut !== null) {
    const kmDriven = params.odometerIn - params.odometerOut;
    if (params.includedKmPerDay !== null && params.extraKmRate !== null) {
      const allowance = params.includedKmPerDay * params.rentalDays;
      const extraKm = kmDriven - allowance;
      if (extraKm > 0) {
        const totalAmount = multiplyByQty(params.extraKmRate, extraKm);
        const description = `Mileage overage (${extraKm} km beyond allowance)`;
        newLineItems.push({
          bookingId: params.bookingId,
          type: "EXTRA_CHARGE",
          description,
          quantity: extraKm,
          unitAmount: params.extraKmRate,
          totalAmount,
          isTaxable: false,
          sortOrder: 100,
          currency: params.currency,
        });
        lineItemsAdded.push({ type: "EXTRA_CHARGE", description, totalAmount });
      }
    }
  }

  return { newLineItems, lineItemsAdded, ratesMissing: { lateFee: isLate, fuel: fuelShort } };
}

export interface CheckInPreview {
  ok: true;
  lineItemsAdded: CheckInLineItemResult[];
  ratesMissing: CheckInRatesMissing;
  projectedSubtotal: bigint;
  projectedTax: bigint;
  projectedTotal: bigint;
}

// Read-only — writes nothing. The check-in screen calls this to render the
// "clear summary of extra charges" the spec requires before the customer is
// actually charged; checkInBooking below performs the identical computation
// again inside its own transaction and is the only function that persists.
export async function previewCheckIn(
  bookingId: string,
  input: { odometerIn: number; fuelIn: number },
  now: Date = new Date()
): Promise<CheckInPreview | { ok: false; reason: CheckInRejectionReason }> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { vehicle: true } });
  if (!booking || (booking.status !== "ONGOING" && booking.status !== "COMPLETED")) {
    return { ok: false, reason: "NOT_ONGOING" };
  }
  if (booking.status === "COMPLETED") {
    return { ok: false, reason: "ALREADY_CHECKED_IN" };
  }
  if (booking.odometerOut !== null && input.odometerIn < booking.odometerOut) {
    return { ok: false, reason: "ODOMETER_BELOW_CHECKOUT" };
  }

  const settings = await prisma.settings.findFirst({ select: { billingGraceMinutes: true, taxRateBps: true } });
  const { lineItemsAdded, ratesMissing } = computeExtraCharges({
    bookingId,
    currency: booking.currency,
    rentalDays: booking.rentalDays,
    returnAt: booking.returnAt,
    odometerOut: booking.odometerOut,
    fuelOut: booking.fuelOut,
    odometerIn: input.odometerIn,
    now,
    billingGraceMinutes: settings?.billingGraceMinutes ?? 0,
    includedKmPerDay: booking.vehicle.includedKmPerDay,
    extraKmRate: booking.vehicle.extraKmRate,
  });
  ratesMissing.fuel = booking.fuelOut !== null && input.fuelIn < booking.fuelOut;

  const existingLineItems = await prisma.bookingLineItem.findMany({ where: { bookingId } });
  const existingSubtotal = existingLineItems.reduce((sum, li) => sum + li.totalAmount, BigInt(0));
  const existingTaxable = existingLineItems.filter((li) => li.isTaxable).reduce((sum, li) => sum + li.totalAmount, BigInt(0));
  // newLineItems are all EXTRA_CHARGE / isTaxable: false (see
  // computeExtraCharges) — lineItemsAdded carries the same totals with a
  // simple bigint field, avoiding Prisma's widened CreateManyInput type.
  const addedSubtotal = lineItemsAdded.reduce((sum, li) => sum + li.totalAmount, BigInt(0));
  const addedTaxable = BigInt(0);

  const projectedSubtotal = existingSubtotal + addedSubtotal;
  const projectedTax = applyBasisPoints(existingTaxable + addedTaxable, settings?.taxRateBps ?? 0);
  const projectedTotal = projectedSubtotal + projectedTax;

  return { ok: true, lineItemsAdded, ratesMissing, projectedSubtotal, projectedTax, projectedTotal };
}

export async function checkInBooking(
  bookingId: string,
  input: CheckInInput,
  options?: CheckInOptions
): Promise<CheckInOutcome> {
  const now = options?.now ?? new Date();

  const run = async (tx: Prisma.TransactionClient): Promise<CheckInOutcome> => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { vehicle: true } });
    if (!booking || (booking.status !== "ONGOING" && booking.status !== "COMPLETED")) {
      return { ok: false, reason: "NOT_ONGOING" };
    }
    if (booking.status === "COMPLETED") {
      return { ok: false, reason: "ALREADY_CHECKED_IN" };
    }
    if (booking.odometerOut !== null && input.odometerIn < booking.odometerOut) {
      return { ok: false, reason: "ODOMETER_BELOW_CHECKOUT" };
    }

    const settings = await tx.settings.findFirst({ select: { billingGraceMinutes: true, taxRateBps: true } });
    const { newLineItems, lineItemsAdded, ratesMissing } = computeExtraCharges({
      bookingId,
      currency: booking.currency,
      rentalDays: booking.rentalDays,
      returnAt: booking.returnAt,
      odometerOut: booking.odometerOut,
      fuelOut: booking.fuelOut,
      odometerIn: input.odometerIn,
      now,
      billingGraceMinutes: settings?.billingGraceMinutes ?? 0,
      includedKmPerDay: booking.vehicle.includedKmPerDay,
      extraKmRate: booking.vehicle.extraKmRate,
    });
    ratesMissing.fuel = booking.fuelOut !== null && input.fuelIn < booking.fuelOut;

    if (newLineItems.length > 0) {
      await bookingSteps.insertLineItems(tx, newLineItems);
    }

    const allLineItems = await tx.bookingLineItem.findMany({ where: { bookingId } });
    const subtotalAmount = allLineItems.reduce((sum, li) => sum + li.totalAmount, BigInt(0));
    const taxableAmount = allLineItems.filter((li) => li.isTaxable).reduce((sum, li) => sum + li.totalAmount, BigInt(0));
    const taxAmount = applyBasisPoints(taxableAmount, settings?.taxRateBps ?? 0);
    const totalAmount = subtotalAmount + taxAmount;

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.COMPLETED,
        odometerIn: input.odometerIn,
        fuelIn: input.fuelIn,
        checkedInAt: now,
        checkedInById: input.staffUserId,
        subtotalAmount,
        taxAmount,
        totalAmount,
      },
    });

    await tx.vehicle.update({
      where: { id: booking.vehicleId },
      data: { currentLocationId: booking.dropoffLocationId },
    });

    // TRUNCATION — the block that held this rental's window is cut back to
    // now + turnaround, freeing the vehicle for same-day rebooking on an
    // early return without silently releasing a later window someone else
    // already holds. found via bookingId FK, matching cancelBooking's
    // existing convention — never recompute the period.
    const { turnaroundMinutes } = await resolveTurnaroundMinutes(tx, booking.pickupLocationId);
    const truncatedEnd = new Date(now.getTime() + turnaroundMinutes * 60_000);
    await tx.$executeRaw`
      UPDATE vehicle_blocks
      SET period = tstzrange(lower(period), ${truncatedEnd}::timestamptz, '[)')
      WHERE booking_id = ${bookingId}::uuid
    `;

    return {
      ok: true,
      bookingId,
      totalAmount,
      lineItemsAdded,
      ratesMissing,
    };
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return prisma.$transaction(run);
}

async function resolveTurnaroundMinutes(tx: Prisma.TransactionClient, locationId: string): Promise<{ turnaroundMinutes: number }> {
  const location = await tx.location.findUnique({ where: { id: locationId }, select: { turnaroundMinutes: true } });
  if (location) return { turnaroundMinutes: location.turnaroundMinutes };
  const settings = await tx.settings.findFirst({ select: { defaultTurnaroundMinutes: true } });
  return { turnaroundMinutes: settings?.defaultTurnaroundMinutes ?? 90 };
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
