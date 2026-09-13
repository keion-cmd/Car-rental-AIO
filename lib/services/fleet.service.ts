import { PrismaClient, Prisma, type BookingStatus, type MaintenanceType } from "@prisma/client";
import { isVehicleAvailable, computeBlockWindow, type DbClient } from "./availability.service";
import { listLocations } from "./catalog.service";

// Fleet management writes: the first write path vehicles have ever had
// (previously seed-only). Live availability status is always derived via
// availability.service's isVehicleAvailable/computeBlockWindow — this file
// never reimplements overlap or buffer math, it only reads vehicle_blocks
// to explain WHY a vehicle that isVehicleAvailable already said "no" is
// unavailable (maintenance vs. an active rental vs. a manual hold).

export const prisma = new PrismaClient();

const EXCLUSION_VIOLATION_CODE = "23P01";

function isExclusionViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2010" &&
    typeof err.meta?.code === "string" &&
    err.meta.code === EXCLUSION_VIOLATION_CODE
  );
}

export type VehicleStatus = "AVAILABLE" | "RENTED" | "RESERVED" | "MAINTENANCE" | "BLOCKED";

// The exclusion constraint (vehicle_blocks_no_overlap, see
// prisma/migrations/20260912113700_vehicle_blocks_no_overlap) covers every
// block_type for a given vehicle_id, so at most one block can cover a given
// instant — there is never an ambiguous "which block wins" case here.
export async function deriveVehicleStatus(
  vehicleId: string,
  currentLocationId: string,
  now: Date,
  db: DbClient = prisma
): Promise<VehicleStatus> {
  const available = await isVehicleAvailable(vehicleId, now, now, db);
  if (available) {
    return "AVAILABLE";
  }

  const { start, end } = await computeBlockWindow(db, currentLocationId, now, now);
  const rows = await db.$queryRaw<Array<{ block_type: string; booking_status: BookingStatus | null }>>`
    SELECT vb.block_type, b.status AS booking_status
    FROM vehicle_blocks vb
    LEFT JOIN bookings b ON b.id = vb.booking_id
    WHERE vb.vehicle_id = ${vehicleId}::uuid
    AND vb.period && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')
    AND NOT (
      vb.block_type = 'HOLD'::"BlockType"
      AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = vb.quote_id AND q.expires_at < now())
    )
    LIMIT 1
  `;

  const block = rows[0];
  if (!block) {
    // Defensive only: isVehicleAvailable said unavailable but no covering
    // block was found under the identical window/filter — should not
    // happen given the shared exclusion constraint.
    return "BLOCKED";
  }
  if (block.block_type === "MAINTENANCE") {
    return "MAINTENANCE";
  }
  if (block.block_type === "BOOKING") {
    return block.booking_status === "ONGOING" ? "RENTED" : "RESERVED";
  }
  return "BLOCKED"; // MANUAL, TRANSFER, or an unexpired HOLD
}

// ==================== LIST / DETAIL (READ) ====================

export interface FleetFilters {
  status?: VehicleStatus;
  categoryId?: string;
  locationId?: string;
  bookableOnline?: boolean;
  archived?: boolean; // undefined/false = active fleet only, true = archived only
  search?: string; // plate number, make, model
}

export interface FleetListRow {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  categoryId: string;
  categoryName: string;
  imageUrl: string | null;
  status: VehicleStatus;
  isBookableOnline: boolean;
  archivedAt: Date | null;
  currentLocationId: string;
  currentLocationName: string;
  dailyRate: bigint;
  nextBookingAt: Date | null;
}

export async function listVehicles(
  filters: FleetFilters,
  now: Date = new Date(),
  db: DbClient = prisma
): Promise<FleetListRow[]> {
  const where: Prisma.VehicleWhereInput = {
    archivedAt: filters.archived ? { not: null } : null,
  };
  if (filters.categoryId) where.model = { categoryId: filters.categoryId };
  if (filters.locationId) where.currentLocationId = filters.locationId;
  if (filters.bookableOnline !== undefined) where.isBookableOnline = filters.bookableOnline;
  if (filters.search) {
    const term = filters.search.trim();
    if (term) {
      where.OR = [
        { plateNumber: { contains: term, mode: "insensitive" } },
        { model: { make: { contains: term, mode: "insensitive" } } },
        { model: { model: { contains: term, mode: "insensitive" } } },
      ];
    }
  }

  const vehicles = await db.vehicle.findMany({
    where,
    orderBy: { plateNumber: "asc" },
    select: {
      id: true,
      plateNumber: true,
      dailyRate: true,
      isBookableOnline: true,
      archivedAt: true,
      currentLocationId: true,
      model: { select: { make: true, model: true, category: { select: { id: true, name: true } } } },
      images: { select: { url: true }, orderBy: { sortOrder: "asc" }, take: 1 },
    },
  });

  const locations = new Map((await listLocations()).map((l) => [l.id, l]));

  const rows: FleetListRow[] = [];
  for (const v of vehicles) {
    const status = await deriveVehicleStatus(v.id, v.currentLocationId, now, db);
    if (filters.status && status !== filters.status) continue;

    const nextBooking = await db.booking.findFirst({
      where: { vehicleId: v.id, status: { in: ["PENDING", "CONFIRMED"] }, pickupAt: { gte: now } },
      orderBy: { pickupAt: "asc" },
      select: { pickupAt: true },
    });

    rows.push({
      id: v.id,
      plateNumber: v.plateNumber,
      make: v.model.make,
      model: v.model.model,
      categoryId: v.model.category.id,
      categoryName: v.model.category.name,
      imageUrl: v.images[0]?.url ?? null,
      status,
      isBookableOnline: v.isBookableOnline,
      archivedAt: v.archivedAt,
      currentLocationId: v.currentLocationId,
      currentLocationName: locations.get(v.currentLocationId)?.name ?? "Unknown location",
      dailyRate: v.dailyRate,
      nextBookingAt: nextBooking?.pickupAt ?? null,
    });
  }
  return rows;
}

export interface FleetBlockRow {
  id: string;
  blockType: string;
  start: Date;
  end: Date;
  bookingId: string | null;
  bookingReference: string | null;
  quoteId: string | null;
}

export interface RentalHistoryRow {
  id: string;
  reference: string;
  pickupAt: Date;
  returnAt: Date;
  rentalDays: number;
  totalAmount: bigint;
  currency: string;
  status: BookingStatus;
}

export interface MaintenanceRow {
  id: string;
  type: MaintenanceType;
  status: string;
  scheduledAt: Date;
  completedAt: Date | null;
  notes: string | null;
}

export interface VehicleDetail {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  seats: number;
  transmission: "MANUAL" | "AUTOMATIC";
  fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  categoryId: string;
  categoryName: string;
  homeLocationId: string;
  homeLocationName: string;
  currentLocationId: string;
  currentLocationName: string;
  isBookableOnline: boolean;
  archivedAt: Date | null;
  status: VehicleStatus;
  dailyRate: bigint;
  weeklyRate: bigint | null;
  monthlyRate: bigint | null;
  securityDeposit: bigint;
  includedKmPerDay: number | null;
  extraKmRate: bigint | null;
  minRentalDays: number;
  maxRentalDays: number | null;
  minDriverAge: number;
  images: Array<{ id: string; url: string; sortOrder: number }>;
  upcomingBlocks: FleetBlockRow[];
  maintenance: MaintenanceRow[];
  rentalHistory: RentalHistoryRow[];
  totalDaysRented: number;
  totalRevenue: bigint;
}

const UPCOMING_BLOCKS_WINDOW_DAYS = 90;

export async function getVehicleDetail(id: string, now: Date = new Date(), db: DbClient = prisma): Promise<VehicleDetail | null> {
  const vehicle = await db.vehicle.findUnique({
    where: { id },
    include: {
      model: { include: { category: true } },
      images: { orderBy: { sortOrder: "asc" } },
      maintenance: { orderBy: { scheduledAt: "desc" } },
    },
  });
  if (!vehicle) return null;

  const locations = new Map((await listLocations()).map((l) => [l.id, l]));

  const status = await deriveVehicleStatus(vehicle.id, vehicle.currentLocationId, now, db);

  const windowEnd = new Date(now.getTime() + UPCOMING_BLOCKS_WINDOW_DAYS * 24 * 60 * 60_000);
  const blockRows = await db.$queryRaw<
    Array<{ id: string; block_type: string; lower: string; upper: string; booking_id: string | null; quote_id: string | null; reference: string | null }>
  >`
    SELECT vb.id, vb.block_type, lower(vb.period)::text AS lower, upper(vb.period)::text AS upper,
           vb.booking_id, vb.quote_id, b.reference
    FROM vehicle_blocks vb
    LEFT JOIN bookings b ON b.id = vb.booking_id
    WHERE vb.vehicle_id = ${id}::uuid
    AND vb.period && tstzrange(${now}::timestamptz, ${windowEnd}::timestamptz, '[)')
    ORDER BY lower(vb.period) ASC
  `;
  const upcomingBlocks: FleetBlockRow[] = blockRows.map((r) => ({
    id: r.id,
    blockType: r.block_type,
    start: new Date(r.lower),
    end: new Date(r.upper),
    bookingId: r.booking_id,
    bookingReference: r.reference,
    quoteId: r.quote_id,
  }));

  const pastBookings = await db.booking.findMany({
    where: { vehicleId: id, returnAt: { lt: now }, status: { not: "CANCELLED" } },
    orderBy: { pickupAt: "desc" },
    select: { id: true, reference: true, pickupAt: true, returnAt: true, rentalDays: true, totalAmount: true, currency: true, status: true },
  });
  const totalDaysRented = pastBookings.reduce((sum, b) => sum + b.rentalDays, 0);
  const totalRevenue = pastBookings.reduce((sum, b) => sum + b.totalAmount, BigInt(0));

  return {
    id: vehicle.id,
    plateNumber: vehicle.plateNumber,
    make: vehicle.model.make,
    model: vehicle.model.model,
    seats: vehicle.model.seats,
    transmission: vehicle.model.transmission,
    fuelType: vehicle.model.fuelType,
    categoryId: vehicle.model.category.id,
    categoryName: vehicle.model.category.name,
    homeLocationId: vehicle.homeLocationId,
    homeLocationName: locations.get(vehicle.homeLocationId)?.name ?? "Unknown location",
    currentLocationId: vehicle.currentLocationId,
    currentLocationName: locations.get(vehicle.currentLocationId)?.name ?? "Unknown location",
    isBookableOnline: vehicle.isBookableOnline,
    archivedAt: vehicle.archivedAt,
    status,
    dailyRate: vehicle.dailyRate,
    weeklyRate: vehicle.weeklyRate,
    monthlyRate: vehicle.monthlyRate,
    securityDeposit: vehicle.securityDeposit,
    includedKmPerDay: vehicle.includedKmPerDay,
    extraKmRate: vehicle.extraKmRate,
    minRentalDays: vehicle.minRentalDays,
    maxRentalDays: vehicle.maxRentalDays,
    minDriverAge: vehicle.minDriverAge,
    images: vehicle.images,
    upcomingBlocks,
    maintenance: vehicle.maintenance,
    rentalHistory: pastBookings,
    totalDaysRented,
    totalRevenue,
  };
}

export interface FleetCategory {
  id: string;
  name: string;
}

export async function listVehicleCategories(db: DbClient = prisma): Promise<FleetCategory[]> {
  return db.vehicleCategory.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

// ==================== CREATE / UPDATE ====================

export interface CreateVehicleInput {
  plateNumber: string;
  categoryId: string;
  make: string;
  model: string;
  seats: number;
  transmission: "MANUAL" | "AUTOMATIC";
  fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  homeLocationId: string;
  currentLocationId: string;
  dailyRate: bigint;
  weeklyRate?: bigint | null;
  monthlyRate?: bigint | null;
  securityDeposit?: bigint;
  includedKmPerDay?: number | null;
  extraKmRate?: bigint | null;
  minRentalDays?: number;
  maxRentalDays?: number | null;
  minDriverAge?: number;
  isBookableOnline?: boolean;
}

// Reuses an existing VehicleModel row when one already matches on every
// spec field (category, make, model, seats, transmission, fuel type) so
// adding a second identical unit does not fork the catalog with a
// duplicate model — two vehicles of the same spec share one VehicleModel,
// exactly as the seeded data already does. Any spec difference (even one
// field) creates a new model row rather than mutating the shared one,
// since other vehicles may already reference it.
async function findOrCreateVehicleModel(
  input: Pick<CreateVehicleInput, "categoryId" | "make" | "model" | "seats" | "transmission" | "fuelType">,
  db: DbClient
): Promise<string> {
  const existing = await db.vehicleModel.findFirst({
    where: {
      categoryId: input.categoryId,
      make: input.make,
      model: input.model,
      seats: input.seats,
      transmission: input.transmission,
      fuelType: input.fuelType,
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await db.vehicleModel.create({
    data: {
      categoryId: input.categoryId,
      make: input.make,
      model: input.model,
      seats: input.seats,
      transmission: input.transmission,
      fuelType: input.fuelType,
    },
  });
  return created.id;
}

export async function createVehicle(input: CreateVehicleInput, options?: { tx?: DbClient }): Promise<{ id: string }> {
  const db = options?.tx ?? prisma;
  const modelId = await findOrCreateVehicleModel(input, db);
  const vehicle = await db.vehicle.create({
    data: {
      modelId,
      plateNumber: input.plateNumber,
      homeLocationId: input.homeLocationId,
      currentLocationId: input.currentLocationId,
      dailyRate: input.dailyRate,
      weeklyRate: input.weeklyRate ?? null,
      monthlyRate: input.monthlyRate ?? null,
      securityDeposit: input.securityDeposit ?? BigInt(0),
      includedKmPerDay: input.includedKmPerDay ?? null,
      extraKmRate: input.extraKmRate ?? null,
      minRentalDays: input.minRentalDays ?? 1,
      maxRentalDays: input.maxRentalDays ?? null,
      minDriverAge: input.minDriverAge ?? 21,
      isBookableOnline: input.isBookableOnline ?? true,
    },
  });
  return { id: vehicle.id };
}

// Vehicle-table fields only. Model/category are set at creation time and
// edited via category/model management screens, out of scope this phase —
// updateVehicle never touches VehicleModel.
export interface UpdateVehicleInput {
  plateNumber?: string;
  homeLocationId?: string;
  currentLocationId?: string;
  dailyRate?: bigint;
  weeklyRate?: bigint | null;
  monthlyRate?: bigint | null;
  securityDeposit?: bigint;
  includedKmPerDay?: number | null;
  extraKmRate?: bigint | null;
  minRentalDays?: number;
  maxRentalDays?: number | null;
  minDriverAge?: number;
}

export async function updateVehicle(id: string, input: UpdateVehicleInput, options?: { tx?: DbClient }): Promise<{ id: string }> {
  const db = options?.tx ?? prisma;
  const vehicle = await db.vehicle.update({ where: { id }, data: input });
  return { id: vehicle.id };
}

export async function setBookableOnline(id: string, value: boolean, options?: { tx?: DbClient }): Promise<{ id: string }> {
  const db = options?.tx ?? prisma;
  const vehicle = await db.vehicle.update({ where: { id }, data: { isBookableOnline: value } });
  return { id: vehicle.id };
}

// ==================== ARCHIVE ====================

export type ArchiveRejectionReason = "HAS_FUTURE_BOOKINGS";

export interface BookingConflict {
  id: string;
  reference: string;
  customerName: string;
  pickupAt: Date;
  returnAt: Date;
  status: BookingStatus;
}

export type ArchiveVehicleOutcome = { ok: true } | { ok: false; reason: ArchiveRejectionReason; conflicts: BookingConflict[] };

// "Future" includes an ONGOING rental in progress, not only bookings whose
// pickup hasn't happened yet — a vehicle currently out with a customer must
// not be archivable either. returnAt > now is the single condition that
// captures both cases without special-casing status.
export async function archiveVehicle(id: string, options?: { tx?: DbClient; now?: Date }): Promise<ArchiveVehicleOutcome> {
  const db = options?.tx ?? prisma;
  const now = options?.now ?? new Date();

  const conflicts = await db.booking.findMany({
    where: { vehicleId: id, status: { in: ["PENDING", "CONFIRMED", "ONGOING"] }, returnAt: { gt: now } },
    orderBy: { pickupAt: "asc" },
    select: { id: true, reference: true, pickupAt: true, returnAt: true, status: true, customer: { select: { name: true } } },
  });
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "HAS_FUTURE_BOOKINGS",
      conflicts: conflicts.map((c) => ({
        id: c.id,
        reference: c.reference,
        customerName: c.customer.name,
        pickupAt: c.pickupAt,
        returnAt: c.returnAt,
        status: c.status,
      })),
    };
  }

  await db.vehicle.update({ where: { id }, data: { archivedAt: now } });
  return { ok: true };
}

// ==================== IMAGES ====================

export async function addVehicleImage(vehicleId: string, url: string, options?: { tx?: DbClient }): Promise<{ id: string }> {
  const db = options?.tx ?? prisma;
  const count = await db.vehicleImage.count({ where: { vehicleId } });
  const image = await db.vehicleImage.create({ data: { vehicleId, url, sortOrder: count } });
  return { id: image.id };
}

// Deliberately does not renumber the remaining rows' sortOrder — their
// relative order (and gaps) stays exactly as it was; only the removed row
// disappears.
export async function removeVehicleImage(imageId: string, options?: { tx?: DbClient }): Promise<{ ok: true }> {
  const db = options?.tx ?? prisma;
  await db.vehicleImage.delete({ where: { id: imageId } });
  return { ok: true };
}

export async function reorderImages(vehicleId: string, orderedImageIds: string[], options?: { tx?: DbClient }): Promise<{ ok: true }> {
  const db = options?.tx ?? prisma;
  for (let index = 0; index < orderedImageIds.length; index++) {
    await db.vehicleImage.update({ where: { id: orderedImageIds[index], vehicleId }, data: { sortOrder: index } });
  }
  return { ok: true };
}

export async function setPrimaryImage(vehicleId: string, imageId: string, options?: { tx?: DbClient }): Promise<{ ok: true }> {
  const db = options?.tx ?? prisma;
  const images = await db.vehicleImage.findMany({ where: { vehicleId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
  const ordered = [imageId, ...images.map((i) => i.id).filter((otherId) => otherId !== imageId)];
  return reorderImages(vehicleId, ordered, options);
}

// ==================== MAINTENANCE ====================

export type MaintenanceRejectionReason = "MAINTENANCE_CONFLICTS_WITH_BOOKINGS";

export interface CreateMaintenanceInput {
  vehicleId: string;
  type: MaintenanceType;
  scheduledAt: Date;
  endAt: Date;
  notes?: string;
}

export type CreateMaintenanceOutcome =
  | { ok: true; maintenanceId: string }
  | { ok: false; reason: MaintenanceRejectionReason; conflicts: BookingConflict[] };

// Grouped as an object (not free functions), same convention as
// bookingSteps in booking.service.ts, so a test can inject a REAL failure
// between the two inserts (vi.spyOn(maintenanceSteps, "insertBlock")) and
// prove the record insert rolls back with it — a genuine Postgres rollback,
// not a simulated one.
export const maintenanceSteps = {
  async insertRecord(tx: Prisma.TransactionClient, input: CreateMaintenanceInput) {
    return tx.maintenanceRecord.create({
      data: {
        vehicleId: input.vehicleId,
        type: input.type,
        status: "SCHEDULED",
        scheduledAt: input.scheduledAt,
        notes: input.notes,
      },
    });
  },
  async insertBlock(tx: Prisma.TransactionClient, vehicleId: string, start: Date, end: Date) {
    return tx.$executeRaw`
      INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
      VALUES (${vehicleId}::uuid, 'MAINTENANCE'::"BlockType", tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)'), now())
    `;
  },
};

// Writes the maintenance record AND the MAINTENANCE vehicle_blocks row in
// one transaction — that block is the entire mechanism by which a serviced
// car stops appearing in availability; there is no separate check anywhere
// else. If the block insert collides with an existing booking, Postgres
// raises 23P01 and the whole transaction (including the record insert)
// rolls back — the catch below never has a record to clean up.
export async function createMaintenance(
  input: CreateMaintenanceInput,
  options?: { tx?: Prisma.TransactionClient; now?: Date }
): Promise<CreateMaintenanceOutcome> {
  const run = async (tx: Prisma.TransactionClient): Promise<CreateMaintenanceOutcome> => {
    const record = await maintenanceSteps.insertRecord(tx, input);
    await maintenanceSteps.insertBlock(tx, input.vehicleId, input.scheduledAt, input.endAt);
    return { ok: true, maintenanceId: record.id };
  };

  try {
    if (options?.tx) {
      return await run(options.tx);
    }
    return await prisma.$transaction(run);
  } catch (err) {
    if (isExclusionViolation(err)) {
      const conflicts = await prisma.booking.findMany({
        where: {
          vehicleId: input.vehicleId,
          status: { in: ["PENDING", "CONFIRMED", "ONGOING"] },
          pickupAt: { lt: input.endAt },
          returnAt: { gt: input.scheduledAt },
        },
        orderBy: { pickupAt: "asc" },
        select: { id: true, reference: true, pickupAt: true, returnAt: true, status: true, customer: { select: { name: true } } },
      });
      return {
        ok: false,
        reason: "MAINTENANCE_CONFLICTS_WITH_BOOKINGS",
        conflicts: conflicts.map((c) => ({
          id: c.id,
          reference: c.reference,
          customerName: c.customer.name,
          pickupAt: c.pickupAt,
          returnAt: c.returnAt,
          status: c.status,
        })),
      };
    }
    throw err;
  }
}

export type CompleteMaintenanceOutcome = { ok: true } | { ok: false; reason: "NOT_FOUND" };

// Truncates the MAINTENANCE block to `now` so an early finish returns the
// car to service immediately, mirroring checkInBooking's block-truncation
// convention in booking.service.ts. The block is matched by vehicle_id +
// block_type + a matching lower bound (the exact scheduledAt it was created
// with in the same transaction) rather than by a stored foreign key —
// MaintenanceRecord/VehicleBlock have no direct link in the schema.
export async function completeMaintenance(
  id: string,
  options?: { tx?: Prisma.TransactionClient; now?: Date }
): Promise<CompleteMaintenanceOutcome> {
  const now = options?.now ?? new Date();

  const run = async (tx: Prisma.TransactionClient): Promise<CompleteMaintenanceOutcome> => {
    const record = await tx.maintenanceRecord.findUnique({ where: { id } });
    if (!record) {
      return { ok: false, reason: "NOT_FOUND" };
    }

    await tx.$executeRaw`
      UPDATE vehicle_blocks
      SET period = tstzrange(lower(period), LEAST(upper(period), ${now}::timestamptz), '[)')
      WHERE vehicle_id = ${record.vehicleId}::uuid
      AND block_type = 'MAINTENANCE'::"BlockType"
      AND lower(period) = ${record.scheduledAt}::timestamptz
    `;

    await tx.maintenanceRecord.update({ where: { id }, data: { status: "COMPLETED", completedAt: now } });
    return { ok: true };
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return prisma.$transaction(run);
}

// ==================== MANUAL BLOCKS ====================

export interface CreateManualBlockInput {
  vehicleId: string;
  start: Date;
  end: Date;
}

export type ManualBlockRejectionReason = "VEHICLE_UNAVAILABLE";
export type CreateManualBlockOutcome = { ok: true; blockId: string } | { ok: false; reason: ManualBlockRejectionReason };

// For transfers, detailing, or owner use — a plain hold with no booking or
// quote behind it. Same constraint, same rejection path as every other
// block type: the exclusion constraint arbitrates, never a pre-check.
export async function createManualBlock(input: CreateManualBlockInput, options?: { tx?: DbClient }): Promise<CreateManualBlockOutcome> {
  const db = options?.tx ?? prisma;
  try {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
      VALUES (${input.vehicleId}::uuid, 'MANUAL'::"BlockType", tstzrange(${input.start}::timestamptz, ${input.end}::timestamptz, '[)'), now())
      RETURNING id
    `;
    return { ok: true, blockId: rows[0].id };
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "VEHICLE_UNAVAILABLE" };
    }
    throw err;
  }
}

export async function removeManualBlock(blockId: string, options?: { tx?: DbClient }): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" }> {
  const db = options?.tx ?? prisma;
  const result = await db.vehicleBlock.deleteMany({ where: { id: blockId, blockType: "MANUAL" } });
  return result.count > 0 ? { ok: true } : { ok: false, reason: "NOT_FOUND" };
}
