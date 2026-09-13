import { PrismaClient, Prisma, type BlockType, type BookingStatus, type MaintenanceType } from "@prisma/client";
import { type DbClient } from "./availability.service";
import { listLocations } from "./catalog.service";

// Read-only fleet-timeline query. Reuses vehicle_blocks exactly as
// availability.service/fleet.service write and read it — this file never
// reimplements the HOLD-expiry filter or buffer/window math, it only
// projects the same rows into a shape a resource-timeline UI can render.
// One range query covers every vehicle's blocks for the visible window;
// there is never a per-vehicle query loop here.

export const prisma = new PrismaClient();

export interface CalendarFilters {
  from: Date;
  to: Date;
  locationId?: string;
  categoryId?: string;
  includeArchived?: boolean;
  // "Only conflicts and overdue" — see hasBufferConflict below for what
  // counts as a conflict.
  onlyConflictsOrOverdue?: boolean;
  rowOffset?: number;
  rowLimit?: number;
}

export interface CalendarBlock {
  id: string;
  blockType: BlockType;
  // The customer-facing period (booking pickup/return, or the block's own
  // period for MAINTENANCE/MANUAL/TRANSFER, which carry no separate buffer).
  rentalStart: Date;
  rentalEnd: Date;
  // The vehicle_blocks period — includes prep/turnaround for BOOKING/HOLD.
  bufferedStart: Date;
  bufferedEnd: Date;
  // Whether this block's buffered period is cut off by the visible window
  // edge, so a bar that starts/ends off-screen never looks like it starts
  // or ends exactly at the window boundary.
  clippedStart: boolean;
  clippedEnd: boolean;
  bookingId: string | null;
  bookingReference: string | null;
  customerName: string | null;
  maintenanceType: MaintenanceType | null;
  isOverdue: boolean;
}

export interface CalendarVehicleRow {
  vehicleId: string;
  plateNumber: string;
  make: string;
  model: string;
  categoryId: string;
  categoryName: string;
  locationId: string;
  locationName: string;
  locationTimezone: string;
  blocks: CalendarBlock[];
}

export interface FleetCalendarResult {
  vehicles: CalendarVehicleRow[];
  // Count after every filter (including onlyConflictsOrOverdue) but before
  // row-pagination slicing — what the pager needs to render "N of M".
  totalVehicleCount: number;
}

// The reference timezone for calendar columns when no single location is
// selected. Settings.businessTimezone always has a value (non-nullable,
// defaulted) — there is exactly one Settings row.
export async function getBusinessTimezone(db: DbClient = prisma): Promise<string> {
  const settings = await db.settings.findFirst({ select: { businessTimezone: true } });
  return settings?.businessTimezone ?? "Asia/Manila";
}

type RawBlockRow = {
  id: string;
  vehicle_id: string;
  block_type: BlockType;
  buffered_start: string;
  buffered_end: string;
  booking_id: string | null;
  booking_reference: string | null;
  booking_pickup_at: Date | null;
  booking_return_at: Date | null;
  booking_status: BookingStatus | null;
  customer_name: string | null;
  maintenance_type: MaintenanceType | null;
  quote_pickup_at: Date | null;
  quote_return_at: Date | null;
};

// Two blocks on the same vehicle whose BUFFERED windows overlap. The
// no-overlap exclusion constraint already forbids two blocks' actual
// periods from overlapping, so this only fires for back-to-back rentals
// whose prep/turnaround buffers touch — exactly the case a naive calendar
// (rental-window-only) hides from staff.
function hasBufferConflict(blocks: CalendarBlock[]): boolean {
  const sorted = [...blocks].sort((a, b) => a.bufferedStart.getTime() - b.bufferedStart.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].bufferedStart.getTime() < sorted[i - 1].bufferedEnd.getTime()) return true;
  }
  return false;
}

export async function getFleetCalendar(
  filters: CalendarFilters,
  now: Date = new Date(),
  db: DbClient = prisma
): Promise<FleetCalendarResult> {
  const { from, to, locationId, categoryId, includeArchived = false, onlyConflictsOrOverdue = false } = filters;
  const rowOffset = filters.rowOffset ?? 0;
  const rowLimit = filters.rowLimit ?? 60;

  const vehicleWhere: Prisma.VehicleWhereInput = {
    archivedAt: includeArchived ? undefined : null,
  };
  if (locationId) vehicleWhere.currentLocationId = locationId;
  if (categoryId) vehicleWhere.model = { categoryId };

  const vehicles = await db.vehicle.findMany({
    where: vehicleWhere,
    orderBy: { plateNumber: "asc" },
    select: {
      id: true,
      plateNumber: true,
      currentLocationId: true,
      model: { select: { make: true, model: true, category: { select: { id: true, name: true } } } },
    },
  });

  if (vehicles.length === 0) {
    return { vehicles: [], totalVehicleCount: 0 };
  }

  const [locationList, settings] = await Promise.all([
    listLocations(),
    db.settings.findFirst({ select: { billingGraceMinutes: true } }),
  ]);
  const locations = new Map(locationList.map((l) => [l.id, l]));
  const billingGraceMinutes = settings?.billingGraceMinutes ?? 59;

  const vehicleIds = vehicles.map((v) => v.id);

  // THE single range query: every block overlapping the visible window for
  // every candidate vehicle, grouped by vehicle in memory below.
  const rows = await db.$queryRaw<RawBlockRow[]>`
    SELECT vb.id, vb.vehicle_id, vb.block_type,
           lower(vb.period)::text AS buffered_start, upper(vb.period)::text AS buffered_end,
           vb.booking_id, b.reference AS booking_reference,
           b.pickup_at AS booking_pickup_at, b.return_at AS booking_return_at, b.status AS booking_status,
           c.name AS customer_name, mr.type AS maintenance_type,
           q.pickup_at AS quote_pickup_at, q.return_at AS quote_return_at
    FROM vehicle_blocks vb
    LEFT JOIN bookings b ON b.id = vb.booking_id
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN quotes q ON q.id = vb.quote_id
    LEFT JOIN maintenance_records mr
      ON mr.vehicle_id = vb.vehicle_id
      AND vb.block_type = 'MAINTENANCE'::"BlockType"
      AND mr.scheduled_at = lower(vb.period)
    WHERE vb.vehicle_id = ANY(${vehicleIds}::uuid[])
    AND vb.period && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
    AND NOT (
      vb.block_type = 'HOLD'::"BlockType"
      AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = vb.quote_id AND q.expires_at < now())
    )
    ORDER BY vb.vehicle_id, lower(vb.period)
  `;

  const blocksByVehicle = new Map<string, CalendarBlock[]>();
  for (const r of rows) {
    const bufferedStart = new Date(r.buffered_start);
    const bufferedEnd = new Date(r.buffered_end);
    const rentalStart = r.booking_pickup_at ?? r.quote_pickup_at ?? bufferedStart;
    const rentalEnd = r.booking_return_at ?? r.quote_return_at ?? bufferedEnd;
    const isOverdue =
      r.booking_status === "ONGOING" &&
      r.booking_return_at !== null &&
      now.getTime() > r.booking_return_at.getTime() + billingGraceMinutes * 60_000;

    const block: CalendarBlock = {
      id: r.id,
      blockType: r.block_type,
      rentalStart,
      rentalEnd,
      bufferedStart,
      bufferedEnd,
      clippedStart: bufferedStart.getTime() < from.getTime(),
      clippedEnd: bufferedEnd.getTime() > to.getTime(),
      bookingId: r.booking_id,
      bookingReference: r.booking_reference,
      customerName: r.customer_name,
      maintenanceType: r.maintenance_type,
      isOverdue,
    };
    const list = blocksByVehicle.get(r.vehicle_id) ?? [];
    list.push(block);
    blocksByVehicle.set(r.vehicle_id, list);
  }

  let vehicleRows: CalendarVehicleRow[] = vehicles.map((v) => {
    const location = locations.get(v.currentLocationId);
    return {
      vehicleId: v.id,
      plateNumber: v.plateNumber,
      make: v.model.make,
      model: v.model.model,
      categoryId: v.model.category.id,
      categoryName: v.model.category.name,
      locationId: v.currentLocationId,
      locationName: location?.name ?? "Unknown location",
      locationTimezone: location?.timezone ?? "UTC",
      blocks: blocksByVehicle.get(v.id) ?? [],
    };
  });

  if (onlyConflictsOrOverdue) {
    vehicleRows = vehicleRows.filter(
      (v) => v.blocks.some((b) => b.isOverdue) || hasBufferConflict(v.blocks)
    );
  }

  const totalVehicleCount = vehicleRows.length;
  const paged = vehicleRows.slice(rowOffset, rowOffset + rowLimit);

  return { vehicles: paged, totalVehicleCount };
}
