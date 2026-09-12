import type { LineItemType } from "@prisma/client";
import { multiplyByQty, roundDivision, applyBasisPoints } from "../money";
import { rentalDays } from "../rental-days";

// Pure function: quote(input) -> QuoteOutcome. No database writes, no clock
// reads ("now" is passed in), no randomness. Same inputs always produce the
// same output, so a result is reproducible in a dispute.

export type QuoteRejectionReason =
  | "INVALID_DATE_RANGE"
  | "VEHICLE_NOT_PRICED"
  | "BELOW_MIN_RENTAL_DAYS"
  | "ABOVE_MAX_RENTAL_DAYS"
  | "ONE_WAY_NOT_ALLOWED"
  | "DRIVER_UNDER_AGE";

export interface QuoteLineItemResult {
  type: LineItemType;
  description: string;
  quantity: number;
  unitAmount: bigint;
  totalAmount: bigint;
  isTaxable: boolean;
  sortOrder: number;
}

export interface QuoteVehicleInput {
  dailyRate: bigint;
  weeklyRate: bigint | null;
  monthlyRate: bigint | null;
  securityDeposit: bigint;
  minRentalDays: number;
  maxRentalDays: number | null;
  minDriverAge: number;
}

export interface QuoteSettingsInput {
  currency: string;
  taxRateBps: number;
  youngDriverMaxAge: number;
  youngDriverSurchargePerDay: bigint;
  billingGraceMinutes: number;
}

export interface QuoteLocationPairInput {
  isAllowed: boolean;
  feeAmount: bigint;
}

export interface QuoteInput {
  vehicle: QuoteVehicleInput;
  pickupLocationId: string;
  returnLocationId: string;
  pickupAt: Date;
  returnAt: Date;
  driverDateOfBirth: Date;
  now: Date;
  settings: QuoteSettingsInput;
  // The pair for (pickupLocationId, returnLocationId), pre-resolved by the
  // caller. null when pickup === return (no lookup needed) or when no pair
  // row exists for a one-way combination.
  locationPair: QuoteLocationPairInput | null;
}

export interface QuoteRejection {
  ok: false;
  reason: QuoteRejectionReason;
}

export interface QuoteResult {
  ok: true;
  lineItems: QuoteLineItemResult[];
  subtotalAmount: bigint;
  taxAmount: bigint;
  totalAmount: bigint;
  securityDeposit: bigint;
  currency: string;
  rentalDays: number;
}

export type QuoteOutcome = QuoteResult | QuoteRejection;

const ZERO = BigInt(0);
const WEEK_DAYS = BigInt(7);
const MONTH_DAYS = BigInt(30);

function isPriced(rate: bigint | null): rate is bigint {
  return rate !== null && rate > ZERO;
}

function computeAge(dateOfBirth: Date, now: Date): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

// Selects the per-day rate for the tier the duration falls into, falling
// through to the next cheaper tier if the natural tier's rate is absent or
// non-positive (the zero-rate guard: an unpriced tier is never free).
// Whatever tier is selected, its total is then clamped so it can never
// exceed the plain daily-rate total for the same number of days.
function baseRateLine(vehicle: QuoteVehicleInput, days: number): { unitAmount: bigint; totalAmount: bigint } {
  const dailyTotal = multiplyByQty(vehicle.dailyRate, days);

  let tierUnitAmount: bigint | null = null;
  if (days >= 28 && isPriced(vehicle.monthlyRate)) {
    tierUnitAmount = roundDivision(vehicle.monthlyRate, MONTH_DAYS);
  } else if (days >= 7 && isPriced(vehicle.weeklyRate)) {
    tierUnitAmount = roundDivision(vehicle.weeklyRate, WEEK_DAYS);
  }

  if (tierUnitAmount === null) {
    return { unitAmount: vehicle.dailyRate, totalAmount: dailyTotal };
  }

  const tierTotal = multiplyByQty(tierUnitAmount, days);
  if (tierTotal < dailyTotal) {
    return { unitAmount: tierUnitAmount, totalAmount: tierTotal };
  }
  return { unitAmount: vehicle.dailyRate, totalAmount: dailyTotal };
}

export function quote(input: QuoteInput): QuoteOutcome {
  const durationResult = rentalDays(input.pickupAt, input.returnAt, input.settings.billingGraceMinutes);
  if (!durationResult.ok) {
    return { ok: false, reason: "INVALID_DATE_RANGE" };
  }
  const days = durationResult.days;

  if (!isPriced(input.vehicle.dailyRate)) {
    return { ok: false, reason: "VEHICLE_NOT_PRICED" };
  }

  if (days < input.vehicle.minRentalDays) {
    return { ok: false, reason: "BELOW_MIN_RENTAL_DAYS" };
  }
  if (input.vehicle.maxRentalDays !== null && days > input.vehicle.maxRentalDays) {
    return { ok: false, reason: "ABOVE_MAX_RENTAL_DAYS" };
  }

  const lineItems: QuoteLineItemResult[] = [];
  let sortOrder = 0;

  const base = baseRateLine(input.vehicle, days);
  lineItems.push({
    type: "BASE_RATE",
    description: "Base rental rate",
    quantity: days,
    unitAmount: base.unitAmount,
    totalAmount: base.totalAmount,
    isTaxable: true,
    sortOrder: sortOrder++,
  });

  const isOneWay = input.pickupLocationId !== input.returnLocationId;
  if (isOneWay) {
    if (!input.locationPair || !input.locationPair.isAllowed) {
      return { ok: false, reason: "ONE_WAY_NOT_ALLOWED" };
    }
    lineItems.push({
      type: "FEE",
      description: "One-way fee",
      quantity: 1,
      unitAmount: input.locationPair.feeAmount,
      totalAmount: input.locationPair.feeAmount,
      isTaxable: true,
      sortOrder: sortOrder++,
    });
  }

  const driverAge = computeAge(input.driverDateOfBirth, input.now);
  if (driverAge < input.vehicle.minDriverAge) {
    return { ok: false, reason: "DRIVER_UNDER_AGE" };
  }

  if (driverAge <= input.settings.youngDriverMaxAge) {
    const perDay = input.settings.youngDriverSurchargePerDay;
    lineItems.push({
      type: "SURCHARGE",
      description: "Young driver surcharge",
      quantity: days,
      unitAmount: perDay,
      totalAmount: multiplyByQty(perDay, days),
      isTaxable: true,
      sortOrder: sortOrder++,
    });
  }

  const subtotalAmount = lineItems.reduce((sum, line) => sum + line.totalAmount, ZERO);
  const taxableAmount = lineItems
    .filter((line) => line.isTaxable)
    .reduce((sum, line) => sum + line.totalAmount, ZERO);
  const taxAmount = applyBasisPoints(taxableAmount, input.settings.taxRateBps);
  const totalAmount = subtotalAmount + taxAmount;

  return {
    ok: true,
    lineItems,
    subtotalAmount,
    taxAmount,
    totalAmount,
    securityDeposit: input.vehicle.securityDeposit,
    currency: input.settings.currency,
    rentalDays: days,
  };
}
