import { PrismaClient, Prisma } from "@prisma/client";

// Buffer resolution: Location.prepMinutes / Location.turnaroundMinutes exist
// on the schema (both non-null, defaulted), so they are the source of truth
// for window expansion. Settings.defaultTurnaroundMinutes is only a
// fallback for the (currently impossible) case of a missing location row.
//
// isVehicleAvailable() has no locationId parameter, so its buffers are
// resolved from the vehicle's CURRENT location (where it actually sits and
// would need prep/turnaround), not the pickup location of some other
// hypothetical request.

export const prisma = new PrismaClient();

export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AvailabilityFilters {
  categoryId?: string;
  transmission?: "MANUAL" | "AUTOMATIC";
  fuelType?: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  minSeats?: number;
}

export interface Buffers {
  prepMinutes: number;
  turnaroundMinutes: number;
}

async function resolveBuffersForLocation(db: DbClient, locationId: string): Promise<Buffers> {
  const location = await db.location.findUnique({
    where: { id: locationId },
    select: { prepMinutes: true, turnaroundMinutes: true },
  });
  if (location) {
    return { prepMinutes: location.prepMinutes, turnaroundMinutes: location.turnaroundMinutes };
  }
  const settings = await db.settings.findFirst({ select: { defaultTurnaroundMinutes: true } });
  return { prepMinutes: 0, turnaroundMinutes: settings?.defaultTurnaroundMinutes ?? 90 };
}

// Exported so fleet.service's batched status derivation can expand a window
// per vehicle from buffers it already fetched in bulk, without either
// reimplementing this arithmetic or paying resolveBuffersForLocation's
// one-location-at-a-time DB round trip per vehicle.
export function expandWindow(pickupAt: Date, returnAt: Date, buffers: Buffers): { start: Date; end: Date } {
  const start = new Date(pickupAt.getTime() - buffers.prepMinutes * 60_000);
  const end = new Date(returnAt.getTime() + buffers.turnaroundMinutes * 60_000);
  return { start, end };
}

// Exported so booking.service.ts can compute the exact vehicle_blocks
// period it needs to insert without reimplementing buffer/window logic —
// this file remains the single place that owns overlap/window rules.
export async function computeBlockWindow(
  db: DbClient,
  locationId: string,
  pickupAt: Date,
  returnAt: Date
): Promise<{ start: Date; end: Date }> {
  const buffers = await resolveBuffersForLocation(db, locationId);
  return expandWindow(pickupAt, returnAt, buffers);
}

export async function isVehicleAvailable(
  vehicleId: string,
  pickupAt: Date,
  returnAt: Date,
  tx?: DbClient
): Promise<boolean> {
  const db = tx ?? prisma;

  const vehicle = await db.vehicle.findUnique({
    where: { id: vehicleId },
    select: { currentLocationId: true },
  });
  if (!vehicle) {
    return false;
  }

  const buffers = await resolveBuffersForLocation(db, vehicle.currentLocationId);
  const { start, end } = expandWindow(pickupAt, returnAt, buffers);

  // A HOLD block whose quote has expired must not be able to permanently
  // hide a vehicle from availability — this holds regardless of whether
  // releaseExpiredHolds() has run yet.
  const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM vehicle_blocks vb
      WHERE vb.vehicle_id = ${vehicleId}::uuid
      AND vb.period && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
      AND NOT (
        vb.block_type = 'HOLD'::"BlockType"
        AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = vb.quote_id AND q.expires_at < now())
      )
    ) AS blocked
  `;

  return !rows[0]?.blocked;
}

// Card-rendering data (make/model/seats/transmission/fuel/category/image)
// plus every field the pricing engine needs (see QuoteVehicleInput in
// lib/pricing/quote.ts), so a caller pricing a search result never has to
// re-fetch the vehicle or duplicate this select elsewhere.
export interface AvailableVehicle {
  id: string;
  plateNumber: string;
  dailyRate: bigint;
  weeklyRate: bigint | null;
  monthlyRate: bigint | null;
  securityDeposit: bigint;
  minRentalDays: number;
  maxRentalDays: number | null;
  minDriverAge: number;
  model: {
    id: string;
    make: string;
    model: string;
    seats: number;
    transmission: "MANUAL" | "AUTOMATIC";
    fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
    category: { id: string; name: string };
  };
  images: Array<{ url: string }>;
}

export async function findAvailableVehicles(
  pickupLocationId: string,
  pickupAt: Date,
  returnAt: Date,
  filters?: AvailabilityFilters,
  tx?: DbClient
): Promise<AvailableVehicle[]> {
  const db = tx ?? prisma;

  const buffers = await resolveBuffersForLocation(db, pickupLocationId);
  const { start, end } = expandWindow(pickupAt, returnAt, buffers);

  const modelWhere: Prisma.VehicleModelWhereInput = {};
  if (filters?.categoryId) modelWhere.categoryId = filters.categoryId;
  if (filters?.transmission) modelWhere.transmission = filters.transmission;
  if (filters?.fuelType) modelWhere.fuelType = filters.fuelType;
  if (filters?.minSeats !== undefined) modelWhere.seats = { gte: filters.minSeats };

  const candidates = await db.vehicle.findMany({
    where: {
      currentLocationId: pickupLocationId,
      archivedAt: null,
      isBookableOnline: true,
      ...(Object.keys(modelWhere).length > 0 ? { model: modelWhere } : {}),
    },
    select: {
      id: true,
      plateNumber: true,
      dailyRate: true,
      weeklyRate: true,
      monthlyRate: true,
      securityDeposit: true,
      minRentalDays: true,
      maxRentalDays: true,
      minDriverAge: true,
      model: {
        select: {
          id: true,
          make: true,
          model: true,
          seats: true,
          transmission: true,
          fuelType: true,
          category: { select: { id: true, name: true } },
        },
      },
      images: { select: { url: true }, orderBy: { sortOrder: "asc" }, take: 1 },
    },
  });

  if (candidates.length === 0) {
    return [];
  }

  const candidateIds = candidates.map((v) => v.id);
  const blockedRows = await db.$queryRaw<Array<{ vehicle_id: string }>>`
    SELECT DISTINCT vb.vehicle_id FROM vehicle_blocks vb
    WHERE vb.vehicle_id = ANY(${candidateIds}::uuid[])
    AND vb.period && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
    AND NOT (
      vb.block_type = 'HOLD'::"BlockType"
      AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = vb.quote_id AND q.expires_at < now())
    )
  `;
  const blockedIds = new Set(blockedRows.map((r) => r.vehicle_id));

  return candidates.filter((v) => !blockedIds.has(v.id));
}
