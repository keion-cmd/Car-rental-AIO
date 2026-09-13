import { PrismaClient } from "@prisma/client";
import { searchParamsSchema, type SearchParams } from "../validation/search";
import { getLocationById } from "./catalog.service";
import { findAvailableVehicles } from "./availability.service";
import { priceRequest } from "./quote.service";
import { zonedTimeToUtc } from "../timezone";

// Orchestrates the public /search page: validate → resolve locations →
// convert wall-clock input to UTC → ask availability → price each candidate.
// Pure server-side logic (no rendering) so it can be exercised directly by
// tests without a browser/component harness.

const prisma = new PrismaClient();

export interface SearchCriteria {
  pickupLocationId: string;
  pickupLocationName: string;
  dropoffLocationId: string;
  dropoffLocationName: string;
  pickupAt: Date;
  returnAt: Date;
}

export interface SearchResultVehicle {
  id: string;
  make: string;
  model: string;
  seats: number;
  transmission: "MANUAL" | "AUTOMATIC";
  fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  categoryName: string;
  imageUrl: string | null;
  dailyRate: bigint;
  totalAmount: bigint;
  currency: string;
}

export type SearchOutcome =
  | { ok: false; reason: "INVALID_PARAMS" }
  | { ok: false; reason: "LOCATION_NOT_FOUND" }
  | { ok: true; criteria: SearchCriteria; vehicles: SearchResultVehicle[] };

export type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseSearchParams(raw: RawSearchParams): ReturnType<typeof searchParamsSchema.safeParse> {
  const normalised = {
    pickupLocationId: firstValue(raw.pickupLocationId),
    dropoffLocationId: firstValue(raw.dropoffLocationId) || undefined,
    pickupDate: firstValue(raw.pickupDate),
    pickupTime: firstValue(raw.pickupTime),
    returnDate: firstValue(raw.returnDate),
    returnTime: firstValue(raw.returnTime),
  };
  return searchParamsSchema.safeParse(normalised);
}

// No customer/driver identity exists yet at search time (the booking flow —
// out of scope this phase — is what captures a real driverDateOfBirth). We
// price as a standard adult driver clear of every seeded vehicle's
// minDriverAge and above Settings.youngDriverMaxAge, so the displayed total
// is the base rate a typical adult pays; booking re-prices with the real DOB.
export function assumedDriverDateOfBirth(now: Date): Date {
  const dob = new Date(now);
  dob.setUTCFullYear(now.getUTCFullYear() - 30);
  return dob;
}

export async function runVehicleSearch(raw: RawSearchParams): Promise<SearchOutcome> {
  const parsed = parseSearchParams(raw);
  if (!parsed.success) {
    return { ok: false, reason: "INVALID_PARAMS" };
  }
  const params: SearchParams = parsed.data;

  const pickupLocation = await getLocationById(params.pickupLocationId);
  if (!pickupLocation) {
    return { ok: false, reason: "LOCATION_NOT_FOUND" };
  }

  const dropoffLocationId = params.dropoffLocationId ?? params.pickupLocationId;
  const dropoffLocation =
    dropoffLocationId === pickupLocation.id ? pickupLocation : await getLocationById(dropoffLocationId);
  if (!dropoffLocation) {
    return { ok: false, reason: "LOCATION_NOT_FOUND" };
  }

  // Both pickup and return wall-clock times are interpreted against the
  // PICKUP location's timezone, per product spec.
  const pickupAt = zonedTimeToUtc(params.pickupDate, params.pickupTime, pickupLocation.timezone);
  const returnAt = zonedTimeToUtc(params.returnDate, params.returnTime, pickupLocation.timezone);

  const candidates = await findAvailableVehicles(params.pickupLocationId, pickupAt, returnAt);

  const now = new Date();
  const driverDateOfBirth = assumedDriverDateOfBirth(now);

  const vehicles: SearchResultVehicle[] = [];
  for (const candidate of candidates) {
    const priced = await priceRequest(prisma, {
      vehicleId: candidate.id,
      pickupLocationId: params.pickupLocationId,
      returnLocationId: dropoffLocationId,
      pickupAt,
      returnAt,
      driverDateOfBirth,
      now,
    });

    if (!priced.ok) {
      console.error(
        `[search] vehicle ${candidate.id} priced out: ${priced.reason}`
      );
      continue;
    }

    vehicles.push({
      id: candidate.id,
      make: candidate.model.make,
      model: candidate.model.model,
      seats: candidate.model.seats,
      transmission: candidate.model.transmission,
      fuelType: candidate.model.fuelType,
      categoryName: candidate.model.category.name,
      imageUrl: candidate.images[0]?.url ?? null,
      dailyRate: candidate.dailyRate,
      totalAmount: priced.totalAmount,
      currency: priced.currency,
    });
  }

  return {
    ok: true,
    criteria: {
      pickupLocationId: params.pickupLocationId,
      pickupLocationName: pickupLocation.name,
      dropoffLocationId,
      dropoffLocationName: dropoffLocation.name,
      pickupAt,
      returnAt,
    },
    vehicles,
  };
}
