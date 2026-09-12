import { PrismaClient, Prisma, QuoteStatus } from "@prisma/client";
import {
  quote,
  type QuoteResult,
  type QuoteRejectionReason,
  type QuoteVehicleInput,
  type QuoteSettingsInput,
  type QuoteLocationPairInput,
} from "../pricing/quote";
import { computeBlockWindow, type DbClient } from "./availability.service";

const prisma = new PrismaClient();

const EXCLUSION_VIOLATION_CODE = "23P01";

function isExclusionViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2010" &&
    typeof err.meta?.code === "string" &&
    err.meta.code === EXCLUSION_VIOLATION_CODE
  );
}

// Explicit hold TTL, persisted onto Quote.expiresAt at creation time so it
// survives a stale in-memory read.
const QUOTE_TTL_MINUTES = 30;

export type PriceRequestRejectionReason = QuoteRejectionReason | "VEHICLE_NOT_FOUND";
export type PriceRequestOutcome = QuoteResult | { ok: false; reason: PriceRequestRejectionReason };

export interface PriceRequestInput {
  vehicleId: string;
  pickupLocationId: string;
  returnLocationId: string;
  pickupAt: Date;
  returnAt: Date;
  driverDateOfBirth: Date;
  now: Date;
}

// Shared pricing assembly: fetches the vehicle's current rates, settings,
// and (for one-way requests) the location pair, then calls the pure
// pricing engine in lib/pricing/quote.ts. Used by both createQuote and
// booking.service's createBooking so there is exactly one place that
// assembles pricing inputs from the database.
export async function priceRequest(db: DbClient, input: PriceRequestInput): Promise<PriceRequestOutcome> {
  const vehicle = await db.vehicle.findUnique({ where: { id: input.vehicleId } });
  if (!vehicle) {
    return { ok: false, reason: "VEHICLE_NOT_FOUND" };
  }

  const settingsRow = await db.settings.findFirst();
  const settings: QuoteSettingsInput = settingsRow
    ? {
        currency: settingsRow.currency,
        taxRateBps: settingsRow.taxRateBps,
        youngDriverMaxAge: settingsRow.youngDriverMaxAge,
        youngDriverSurchargePerDay: settingsRow.youngDriverSurchargePerDay,
        billingGraceMinutes: settingsRow.billingGraceMinutes,
      }
    : {
        currency: "PHP",
        taxRateBps: 0,
        youngDriverMaxAge: 0,
        youngDriverSurchargePerDay: BigInt(0),
        billingGraceMinutes: 0,
      };

  let locationPair: QuoteLocationPairInput | null = null;
  if (input.pickupLocationId !== input.returnLocationId) {
    const pair = await db.locationPair.findUnique({
      where: {
        fromLocationId_toLocationId: {
          fromLocationId: input.pickupLocationId,
          toLocationId: input.returnLocationId,
        },
      },
    });
    locationPair = pair ? { isAllowed: pair.isAllowed, feeAmount: pair.feeAmount } : null;
  }

  const vehicleInput: QuoteVehicleInput = {
    dailyRate: vehicle.dailyRate,
    weeklyRate: vehicle.weeklyRate,
    monthlyRate: vehicle.monthlyRate,
    securityDeposit: vehicle.securityDeposit,
    minRentalDays: vehicle.minRentalDays,
    maxRentalDays: vehicle.maxRentalDays,
    minDriverAge: vehicle.minDriverAge,
  };

  return quote({
    vehicle: vehicleInput,
    pickupLocationId: input.pickupLocationId,
    returnLocationId: input.returnLocationId,
    pickupAt: input.pickupAt,
    returnAt: input.returnAt,
    driverDateOfBirth: input.driverDateOfBirth,
    now: input.now,
    settings,
    locationPair,
  });
}

export function computeQuoteExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + QUOTE_TTL_MINUTES * 60_000);
}

export interface CreateQuoteInput {
  customerId: string;
  vehicleId: string;
  pickupLocationId: string;
  dropoffLocationId: string;
  pickupAt: Date;
  returnAt: Date;
  driverDateOfBirth: Date;
}

export type CreateQuoteOutcome =
  | { ok: true; quoteId: string; expiresAt: Date; result: QuoteResult }
  | { ok: false; reason: PriceRequestRejectionReason | "VEHICLE_UNAVAILABLE" };

export async function createQuote(input: CreateQuoteInput): Promise<CreateQuoteOutcome> {
  const now = new Date();
  const expiresAt = computeQuoteExpiresAt(now);

  try {
    return await prisma.$transaction(async (tx) => {
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
        return { ok: false, reason: priced.reason };
      }

      const created = await tx.quote.create({
        data: {
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
          status: QuoteStatus.DRAFT,
          expiresAt,
          lineItems: {
            create: priced.lineItems.map((li) => ({
              type: li.type,
              description: li.description,
              quantity: li.quantity,
              unitAmount: li.unitAmount,
              totalAmount: li.totalAmount,
              isTaxable: li.isTaxable,
              sortOrder: li.sortOrder,
            })),
          },
        },
      });

      // HOLD block reserves the same buffered window createBooking would
      // use, bound to this quote via quote_id. The shared exclusion
      // constraint (vehicle_id, period) rejects an overlapping hold or
      // booking on this vehicle regardless of block_type.
      const { start, end } = await computeBlockWindow(tx, input.pickupLocationId, input.pickupAt, input.returnAt);
      await tx.$executeRaw`
        INSERT INTO vehicle_blocks (vehicle_id, block_type, period, quote_id, updated_at)
        VALUES (${input.vehicleId}::uuid, 'HOLD'::"BlockType", tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)'), ${created.id}::uuid, now())
      `;

      return { ok: true, quoteId: created.id, expiresAt, result: priced };
    });
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "VEHICLE_UNAVAILABLE" };
    }
    throw err;
  }
}

export async function getQuote(id: string) {
  const found = await prisma.quote.findUnique({ where: { id }, include: { lineItems: true } });
  if (!found) {
    return null;
  }
  const isExpired = Date.now() > found.expiresAt.getTime();
  return { quote: found, expiresAt: found.expiresAt, isExpired };
}

// Plain function, no scheduler — callers (or a future scheduler, out of
// scope for this phase) invoke this to reclaim vehicle_blocks rows for
// holds whose quote has expired. Returns the number of blocks deleted.
export async function releaseExpiredHolds(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM vehicle_blocks
    WHERE block_type = 'HOLD'::"BlockType"
    AND quote_id IN (SELECT id FROM quotes WHERE expires_at < now())
  `;
}
