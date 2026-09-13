import { prisma } from "./booking.service";
import { createBooking, type CreateBookingOutcome } from "./booking.service";
import {
  createQuote,
  getQuote,
  attachCustomerToQuote,
  priceRequest,
  releaseExpiredHolds,
  type CreateQuoteOutcome,
  type PriceRequestRejectionReason,
} from "./quote.service";
import { findOrCreateCustomer } from "./customer.service";
import { assumedDriverDateOfBirth } from "./search.service";
import { validateDriverLicence, type DriverLicenceRejectionReason } from "../validation/booking";
import type { QuoteResult } from "../pricing/quote";

// This module holds the plain, framework-free business logic behind the
// four-step guest checkout. app/actions/booking-flow.ts wraps these in
// "use server" functions that also call redirect()/parse FormData — kept
// separate so this logic is directly unit-testable (redirect() throws
// outside a Next.js request context).

// -----------------------------------------------------------------------
// Step: entering the flow (Select on /search)
// -----------------------------------------------------------------------

export interface SelectVehicleInput {
  vehicleId: string;
  pickupLocationId: string;
  dropoffLocationId: string;
  pickupAt: Date;
  returnAt: Date;
}

// No real driver identity exists yet at Select-click time — the same
// standard-adult assumption /search itself prices with (see
// assumedDriverDateOfBirth) is used here. The real driverDateOfBirth
// arrives at step 2 and re-prices via repriceForDriver, and again,
// authoritatively, inside createBooking at step 4.
export async function selectVehicle(input: SelectVehicleInput, now: Date = new Date()): Promise<CreateQuoteOutcome> {
  // An expired HOLD's vehicle_blocks row is not reclaimed automatically —
  // releaseExpiredHolds() is the existing, tested utility for that (see
  // quote.service.ts). Without this, the exclusion constraint would still
  // see the stale row and reject an otherwise-free vehicle/window.
  await releaseExpiredHolds();
  return createQuote(
    {
      vehicleId: input.vehicleId,
      pickupLocationId: input.pickupLocationId,
      dropoffLocationId: input.dropoffLocationId,
      pickupAt: input.pickupAt,
      returnAt: input.returnAt,
      driverDateOfBirth: assumedDriverDateOfBirth(now),
    },
    now
  );
}

// -----------------------------------------------------------------------
// Step 2: driver details re-pricing + eligibility check
// -----------------------------------------------------------------------

export type RepriceRejectionReason =
  | "QUOTE_NOT_FOUND"
  | "QUOTE_EXPIRED"
  | PriceRequestRejectionReason
  | DriverLicenceRejectionReason;

export interface RepriceInput {
  quoteId: string;
  driverDateOfBirth: Date;
  driverLicenceExpiry: Date;
}

export type RepriceOutcome = { ok: true; result: QuoteResult } | { ok: false; reason: RepriceRejectionReason };

// Takes only what the age/licence rules need (DOB, licence expiry) — the
// licence NUMBER itself never needs to reach the server until step 4's
// final submission, so this step never receives it.
export async function repriceForDriver(input: RepriceInput, now: Date = new Date()): Promise<RepriceOutcome> {
  const record = await getQuote(input.quoteId);
  if (!record) {
    return { ok: false, reason: "QUOTE_NOT_FOUND" };
  }
  if (record.isExpired) {
    return { ok: false, reason: "QUOTE_EXPIRED" };
  }
  const q = record.quote;

  const priced = await priceRequest(prisma, {
    vehicleId: q.vehicleId,
    pickupLocationId: q.pickupLocationId,
    returnLocationId: q.dropoffLocationId,
    pickupAt: q.pickupAt,
    returnAt: q.returnAt,
    driverDateOfBirth: input.driverDateOfBirth,
    now,
  });
  if (!priced.ok) {
    return { ok: false, reason: priced.reason };
  }

  const licence = validateDriverLicence({ driverLicenceExpiry: input.driverLicenceExpiry, returnAt: q.returnAt }, now);
  if (!licence.ok) {
    return { ok: false, reason: licence.reason };
  }

  return { ok: true, result: priced };
}

// -----------------------------------------------------------------------
// Step 4: atomic submission
// -----------------------------------------------------------------------

export interface SubmitBookingInput {
  quoteId: string;
  driverFullName: string;
  driverEmail: string;
  driverPhone: string;
  driverDateOfBirth: Date;
  driverLicenceNumber: string;
  driverLicenceCountry: string;
  driverLicenceExpiry: Date;
}

export type SubmitBookingOutcome = CreateBookingOutcome | { ok: false; reason: "QUOTE_NOT_FOUND" };

// createBooking signals a rejection (VALIDATION_ERROR, VEHICLE_UNAVAILABLE,
// QUOTE_EXPIRED, ...) by RETURNING { ok: false }, not by throwing — so
// Prisma's $transaction would otherwise happily COMMIT the customer upsert
// that already ran. "A failed booking must leave no orphan customer" means
// every rejection, not just a thrown exception, must roll back. This
// sentinel forces that: thrown inside the transaction so Postgres rolls
// back, caught just outside and unwrapped back into the original outcome.
class BookingRejected extends Error {
  constructor(public readonly outcome: Extract<CreateBookingOutcome, { ok: false }>) {
    super(`booking rejected: ${outcome.reason}`);
  }
}

// ONE transaction: findOrCreateCustomer(tx), then createBooking(input, {
// tx }) — this is exactly what P3-P0B's { tx } option and nullable
// Quote.customerId were built to enable.
export async function submitBooking(input: SubmitBookingInput, now: Date = new Date()): Promise<SubmitBookingOutcome> {
  const record = await getQuote(input.quoteId);
  if (!record) {
    return { ok: false, reason: "QUOTE_NOT_FOUND" };
  }
  const q = record.quote;

  try {
    return await prisma.$transaction(async (tx) => {
      const customer = await findOrCreateCustomer(
        {
          email: input.driverEmail,
          name: input.driverFullName,
          phone: input.driverPhone,
          dateOfBirth: input.driverDateOfBirth,
        },
        tx
      );

      // Records that this guest's identity resolved to this quote/hold.
      await attachCustomerToQuote(input.quoteId, customer.id, tx);

      const outcome = await createBooking(
        {
          customerId: customer.id,
          vehicleId: q.vehicleId,
          pickupLocationId: q.pickupLocationId,
          dropoffLocationId: q.dropoffLocationId,
          pickupAt: q.pickupAt,
          returnAt: q.returnAt,
          driverDateOfBirth: input.driverDateOfBirth,
          quoteId: input.quoteId,
          driverFullName: input.driverFullName,
          driverPhone: input.driverPhone,
          driverEmail: input.driverEmail,
          driverLicenceNumber: input.driverLicenceNumber,
          driverLicenceCountry: input.driverLicenceCountry,
          driverLicenceExpiry: input.driverLicenceExpiry,
        },
        { tx, now }
      );

      if (!outcome.ok) {
        throw new BookingRejected(outcome);
      }
      return outcome;
    });
  } catch (err) {
    if (err instanceof BookingRejected) {
      return err.outcome;
    }
    throw err;
  }
}
