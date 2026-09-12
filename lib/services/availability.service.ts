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

const prisma = new PrismaClient();

export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AvailabilityFilters {
  categoryId?: string;
  transmission?: "MANUAL" | "AUTOMATIC";
  fuelType?: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  minSeats?: number;
}

interface Buffers {
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

function expandWindow(pickupAt: Date, returnAt: Date, buffers: Buffers): { start: Date; end: Date } {
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

  const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM vehicle_blocks
      WHERE vehicle_id = ${vehicleId}::uuid
      AND period && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
    ) AS blocked
  `;

  return !rows[0]?.blocked;
}

export async function findAvailableVehicles(
  pickupLocationId: string,
  pickupAt: Date,
  returnAt: Date,
  filters?: AvailabilityFilters,
  tx?: DbClient
): Promise<Array<{ id: string; plateNumber: string; dailyRate: bigint }>> {
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
    select: { id: true, plateNumber: true, dailyRate: true },
  });

  if (candidates.length === 0) {
    return [];
  }

  const candidateIds = candidates.map((v) => v.id);
  const blockedRows = await db.$queryRaw<Array<{ vehicle_id: string }>>`
    SELECT DISTINCT vehicle_id FROM vehicle_blocks
    WHERE vehicle_id = ANY(${candidateIds}::uuid[])
    AND period && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
  `;
  const blockedIds = new Set(blockedRows.map((r) => r.vehicle_id));

  return candidates.filter((v) => !blockedIds.has(v.id));
}
