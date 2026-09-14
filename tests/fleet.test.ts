import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  createVehicle,
  updateVehicle,
  listVehicles,
  getVehicleDetail,
  archiveVehicle,
  setBookableOnline,
  createMaintenance,
  completeMaintenance,
  maintenanceSteps,
  createManualBlock,
  removeManualBlock,
  addVehicleImage,
  removeVehicleImage,
  setPrimaryImage,
  deriveVehicleStatus,
  deriveVehicleStatuses,
  prisma as fleetPrisma,
} from "../lib/services/fleet.service";
import { computeBlockWindow, prisma as availabilityPrisma } from "../lib/services/availability.service";
import { runVehicleSearch } from "../lib/services/search.service";
import { listBrowsableVehiclesByCategory } from "../lib/services/catalog.service";
import { getBusinessTimezone, prisma as calendarPrisma } from "../lib/services/calendar.service";
import { localDayKey } from "../lib/timezone";
import { authorize } from "../lib/auth/guard";
import { hashPassword } from "../lib/auth/password";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

let categoryId: string;
let modelId: string;
let customerId: string;
let locationId: string;

const vehicleIds: string[] = [];
const bookingIds: string[] = [];
const maintenanceIds: string[] = [];
const quoteIds: string[] = [];

function futureDate(iso: string): Date {
  return new Date(iso);
}

async function createTestVehicle(overrides: { dailyRate?: bigint; isBookableOnline?: boolean } = {}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `FLT-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: locationId,
      currentLocationId: locationId,
      dailyRate: overrides.dailyRate ?? BigInt(150000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      minDriverAge: 21,
      isBookableOnline: overrides.isBookableOnline ?? true,
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

async function createTestBooking(overrides: {
  vehicleId: string;
  status?: "PENDING" | "CONFIRMED" | "ONGOING" | "COMPLETED" | "CANCELLED";
  pickupAt: Date;
  returnAt: Date;
}) {
  const booking = await prisma.booking.create({
    data: {
      reference: `FLT-${Math.random().toString(36).slice(2, 10)}`,
      customerId,
      vehicleId: overrides.vehicleId,
      pickupLocationId: locationId,
      dropoffLocationId: locationId,
      pickupAt: overrides.pickupAt,
      returnAt: overrides.returnAt,
      rentalDays: 1,
      subtotalAmount: BigInt(150000),
      taxAmount: BigInt(18000),
      totalAmount: BigInt(168000),
      securityDeposit: BigInt(50000),
      status: overrides.status ?? "CONFIRMED",
      driverFullName: "Jane Driver",
      driverPhone: "+639171234567",
      driverEmail: "jane.driver@example.com",
      driverLicenceNumber: "N01-23-456789",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: futureDate("2099-01-01T00:00:00Z"),
    },
  });
  bookingIds.push(booking.id);
  return booking;
}

async function insertRawBlock(vehicleId: string, blockType: string, start: string, end: string, bookingId?: string, quoteId?: string) {
  if (bookingId) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, booking_id, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::uuid, now())`,
      vehicleId,
      blockType,
      start,
      end,
      bookingId
    );
  } else if (quoteId) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, quote_id, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::uuid, now())`,
      vehicleId,
      blockType,
      start,
      end,
      quoteId
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), now())`,
      vehicleId,
      blockType,
      start,
      end
    );
  }
}

async function createTestQuote(overrides: { vehicleId: string; pickupAt: Date; returnAt: Date; expiresAt: Date }) {
  const quote = await prisma.quote.create({
    data: {
      vehicleId: overrides.vehicleId,
      pickupLocationId: locationId,
      dropoffLocationId: locationId,
      pickupAt: overrides.pickupAt,
      returnAt: overrides.returnAt,
      totalAmount: BigInt(168000),
      expiresAt: overrides.expiresAt,
    },
  });
  quoteIds.push(quote.id);
  return quote;
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_fleet_category__" },
    update: {},
    create: { name: "__test_fleet_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "FleetTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `fleet-test-${Date.now()}@example.com`, name: "Fleet Test Customer" },
  });
  customerId = customer.id;

  // Non-zero buffers so a CONFIRMED booking's block window extends before
  // pickupAt — needed for test 5 (RESERVED at the current instant even
  // though the pickup itself hasn't happened yet).
  const location = await prisma.location.create({
    data: {
      name: `__fleet_loc__${Date.now()}`,
      timezone: "UTC",
      openingHours: {},
      prepMinutes: 60,
      turnaroundMinutes: 60,
      supportsPickup: true,
      supportsDropoff: true,
    },
  });
  locationId = location.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.maintenanceRecord.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.booking.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicleImage.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: locationId } });
  await prisma.$disconnect();
  await fleetPrisma.$disconnect();
  await availabilityPrisma.$disconnect();
  await calendarPrisma.$disconnect();
});

describe("vehicle CRUD", () => {
  it("1. createVehicle persists and appears in listVehicles", async () => {
    const plateNumber = `FLT-CREATE-${Math.random().toString(36).slice(2, 8)}`;
    const { id } = await createVehicle({
      plateNumber,
      categoryId,
      make: "FleetTest",
      model: "Unit",
      seats: 5,
      transmission: "AUTOMATIC",
      fuelType: "PETROL",
      homeLocationId: locationId,
      currentLocationId: locationId,
      dailyRate: BigInt(120000),
    });
    vehicleIds.push(id);

    const rows = await listVehicles({ search: plateNumber }, new Date());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });

  it("1b. createVehicle reuses an existing matching VehicleModel", async () => {
    const { id: firstId } = await createVehicle({
      plateNumber: `FLT-REUSE-A-${Math.random().toString(36).slice(2, 6)}`,
      categoryId,
      make: "FleetTest",
      model: "Unit",
      seats: 5,
      transmission: "AUTOMATIC",
      fuelType: "PETROL",
      homeLocationId: locationId,
      currentLocationId: locationId,
      dailyRate: BigInt(100000),
    });
    vehicleIds.push(firstId);
    const { id: secondId } = await createVehicle({
      plateNumber: `FLT-REUSE-B-${Math.random().toString(36).slice(2, 6)}`,
      categoryId,
      make: "FleetTest",
      model: "Unit",
      seats: 5,
      transmission: "AUTOMATIC",
      fuelType: "PETROL",
      homeLocationId: locationId,
      currentLocationId: locationId,
      dailyRate: BigInt(100000),
    });
    vehicleIds.push(secondId);

    const first = await prisma.vehicle.findUniqueOrThrow({ where: { id: firstId } });
    const second = await prisma.vehicle.findUniqueOrThrow({ where: { id: secondId } });
    expect(second.modelId).toBe(first.modelId);
  });

  it("2. updateVehicle changes rates; money stays BigInt minor units", async () => {
    const vehicle = await createTestVehicle({ dailyRate: BigInt(100000) });

    await updateVehicle(vehicle.id, {
      dailyRate: BigInt(175050),
      securityDeposit: BigInt(60000),
      minRentalDays: 2,
      minDriverAge: 23,
    });

    const updated = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(typeof updated.dailyRate).toBe("bigint");
    expect(updated.dailyRate).toBe(BigInt(175050));
    expect(updated.securityDeposit).toBe(BigInt(60000));
    expect(updated.minRentalDays).toBe(2);
  });

  it("3. a vehicle with no blocks shows status AVAILABLE", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-01-01T00:00:00Z");
    const detail = await getVehicleDetail(vehicle.id, now);
    expect(detail?.status).toBe("AVAILABLE");
  });

  it("4. a vehicle with an ONGOING booking shows RENTED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-02-02T12:00:00Z");
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "ONGOING",
      pickupAt: futureDate("2032-02-01T00:00:00Z"),
      returnAt: futureDate("2032-02-03T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "BOOKING", "2032-02-01T00:00:00Z", "2032-02-03T01:00:00Z", booking.id);

    const detail = await getVehicleDetail(vehicle.id, now);
    expect(detail?.status).toBe("RENTED");
  });

  it("5. a vehicle with a future CONFIRMED booking shows RESERVED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-03-01T00:00:00Z");
    // Pickup is 30 minutes after `now` — inside the location's 60-minute
    // prep buffer, so the booking's block window already covers `now`.
    const pickupAt = futureDate("2032-03-01T00:30:00Z");
    const returnAt = futureDate("2032-03-02T00:30:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt, returnAt });
    const { start, end } = await computeBlockWindow(prisma, locationId, pickupAt, returnAt);
    await insertRawBlock(vehicle.id, "BOOKING", start.toISOString(), end.toISOString(), booking.id);

    const detail = await getVehicleDetail(vehicle.id, now);
    expect(detail?.status).toBe("RESERVED");
  });

  it("6. a vehicle in a maintenance window shows MAINTENANCE", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-04-01T12:00:00Z");
    const outcome = await createMaintenance({
      vehicleId: vehicle.id,
      type: "REPAIR",
      scheduledAt: futureDate("2032-04-01T00:00:00Z"),
      endAt: futureDate("2032-04-02T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) maintenanceIds.push(outcome.maintenanceId);

    const detail = await getVehicleDetail(vehicle.id, now);
    expect(detail?.status).toBe("MAINTENANCE");
  });

  it("7. setBookableOnline(false) removes it from public search", async () => {
    const vehicle = await createTestVehicle({ isBookableOnline: true });
    const pickupAt = futureDate("2032-05-01T00:00:00Z");
    const returnAt = futureDate("2032-05-02T00:00:00Z");

    const before = await runVehicleSearch({
      pickupLocationId: locationId,
      pickupDate: "2032-05-01",
      pickupTime: "00:00",
      returnDate: "2032-05-02",
      returnTime: "00:00",
    });
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("expected ok");
    expect(before.vehicles.some((v) => v.id === vehicle.id)).toBe(true);

    await setBookableOnline(vehicle.id, false);

    const after = await runVehicleSearch({
      pickupLocationId: locationId,
      pickupDate: "2032-05-01",
      pickupTime: "00:00",
      returnDate: "2032-05-02",
      returnTime: "00:00",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected ok");
    expect(after.vehicles.some((v) => v.id === vehicle.id)).toBe(false);
    void pickupAt;
    void returnAt;
  });
});

describe("archiving", () => {
  it("8. archiveVehicle on a vehicle with no future bookings succeeds", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-06-01T00:00:00Z");
    const outcome = await archiveVehicle(vehicle.id, { now });
    expect(outcome.ok).toBe(true);

    const updated = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(updated.archivedAt?.getTime()).toBe(now.getTime());
  });

  it("9. an archived vehicle disappears from public search and browse", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-06-05T00:00:00Z");

    const beforeBrowse = await listBrowsableVehiclesByCategory();
    const inBrowseBefore = beforeBrowse.some((c) => c.vehicles.some((v) => v.id === vehicle.id));
    expect(inBrowseBefore).toBe(true);

    await archiveVehicle(vehicle.id, { now });

    const afterBrowse = await listBrowsableVehiclesByCategory();
    const inBrowseAfter = afterBrowse.some((c) => c.vehicles.some((v) => v.id === vehicle.id));
    expect(inBrowseAfter).toBe(false);

    const search = await runVehicleSearch({
      pickupLocationId: locationId,
      pickupDate: "2032-06-10",
      pickupTime: "00:00",
      returnDate: "2032-06-11",
      returnTime: "00:00",
    });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error("expected ok");
    expect(search.vehicles.some((v) => v.id === vehicle.id)).toBe(false);
  });

  it("10. archiveVehicle on a vehicle WITH a future booking is rejected with HAS_FUTURE_BOOKINGS and the conflicts listed", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-07-01T00:00:00Z");
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "CONFIRMED",
      pickupAt: futureDate("2032-07-10T00:00:00Z"),
      returnAt: futureDate("2032-07-11T00:00:00Z"),
    });

    const outcome = await archiveVehicle(vehicle.id, { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("HAS_FUTURE_BOOKINGS");
    expect(outcome.conflicts.map((c) => c.id)).toContain(booking.id);

    const unchanged = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(unchanged.archivedAt).toBeNull();
  });

  it("11. an archived vehicle's past bookings remain intact and readable", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2032-08-15T00:00:00Z");
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "COMPLETED",
      pickupAt: futureDate("2032-08-01T00:00:00Z"),
      returnAt: futureDate("2032-08-02T00:00:00Z"),
    });

    await archiveVehicle(vehicle.id, { now });

    const detail = await getVehicleDetail(vehicle.id, now);
    expect(detail?.archivedAt).not.toBeNull();
    expect(detail?.rentalHistory.some((b) => b.id === booking.id)).toBe(true);
  });
});

describe("maintenance", () => {
  it("12. createMaintenance writes both a record and a MAINTENANCE block", async () => {
    const vehicle = await createTestVehicle();
    const outcome = await createMaintenance({
      vehicleId: vehicle.id,
      type: "SCHEDULED",
      scheduledAt: futureDate("2032-09-01T00:00:00Z"),
      endAt: futureDate("2032-09-02T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    maintenanceIds.push(outcome.maintenanceId);

    const record = await prisma.maintenanceRecord.findUnique({ where: { id: outcome.maintenanceId } });
    expect(record).not.toBeNull();

    const blocks = await prisma.$queryRawUnsafe<Array<{ block_type: string }>>(
      `SELECT block_type FROM vehicle_blocks WHERE vehicle_id = $1::uuid AND block_type = 'MAINTENANCE'::"BlockType"
       AND lower(period) = $2::timestamptz`,
      vehicle.id,
      "2032-09-01T00:00:00Z"
    );
    expect(blocks).toHaveLength(1);
  });

  it("13. the vehicle is then unavailable for that window in public search", async () => {
    const vehicle = await createTestVehicle();
    const outcome = await createMaintenance({
      vehicleId: vehicle.id,
      type: "SCHEDULED",
      scheduledAt: futureDate("2032-09-10T00:00:00Z"),
      endAt: futureDate("2032-09-12T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) maintenanceIds.push(outcome.maintenanceId);

    const search = await runVehicleSearch({
      pickupLocationId: locationId,
      pickupDate: "2032-09-10",
      pickupTime: "06:00",
      returnDate: "2032-09-11",
      returnTime: "00:00",
    });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error("expected ok");
    expect(search.vehicles.some((v) => v.id === vehicle.id)).toBe(false);
  });

  it("14. maintenance overlapping an existing booking is rejected with MAINTENANCE_CONFLICTS_WITH_BOOKINGS, naming the conflicts, and writes NEITHER a record NOR a block", async () => {
    const vehicle = await createTestVehicle();
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "CONFIRMED",
      pickupAt: futureDate("2032-10-05T00:00:00Z"),
      returnAt: futureDate("2032-10-06T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "BOOKING", "2032-10-05T00:00:00Z", "2032-10-06T01:00:00Z", booking.id);

    const recordsBefore = await prisma.maintenanceRecord.count({ where: { vehicleId: vehicle.id } });
    const blocksBefore = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });

    const outcome = await createMaintenance({
      vehicleId: vehicle.id,
      type: "REPAIR",
      scheduledAt: futureDate("2032-10-05T12:00:00Z"),
      endAt: futureDate("2032-10-07T00:00:00Z"),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("MAINTENANCE_CONFLICTS_WITH_BOOKINGS");
    expect(outcome.conflicts.map((c) => c.id)).toContain(booking.id);
    expect(outcome.conflicts[0].customerName).toBe("Fleet Test Customer");

    const recordsAfter = await prisma.maintenanceRecord.count({ where: { vehicleId: vehicle.id } });
    const blocksAfter = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });
    expect(recordsAfter).toBe(recordsBefore);
    expect(blocksAfter).toBe(blocksBefore);
  });

  it("15. completeMaintenance truncates the block; the vehicle becomes available again for the remainder", async () => {
    const vehicle = await createTestVehicle();
    const outcome = await createMaintenance({
      vehicleId: vehicle.id,
      type: "CLEANING",
      scheduledAt: futureDate("2032-11-01T00:00:00Z"),
      endAt: futureDate("2032-11-05T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    maintenanceIds.push(outcome.maintenanceId);

    const completeNow = futureDate("2032-11-02T00:00:00Z");
    const completed = await completeMaintenance(outcome.maintenanceId, { now: completeNow });
    expect(completed.ok).toBe(true);

    const record = await prisma.maintenanceRecord.findUniqueOrThrow({ where: { id: outcome.maintenanceId } });
    expect(record.status).toBe("COMPLETED");
    expect(record.completedAt?.getTime()).toBe(completeNow.getTime());

    // Available again for what was originally the remainder of the window.
    const detailAfter = await getVehicleDetail(vehicle.id, futureDate("2032-11-03T00:00:00Z"));
    expect(detailAfter?.status).toBe("AVAILABLE");
  });
});

describe("manual blocks", () => {
  it("16. createManualBlock makes the vehicle unavailable", async () => {
    const vehicle = await createTestVehicle();
    const outcome = await createManualBlock({
      vehicleId: vehicle.id,
      start: futureDate("2032-12-01T00:00:00Z"),
      end: futureDate("2032-12-02T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);

    const detail = await getVehicleDetail(vehicle.id, futureDate("2032-12-01T06:00:00Z"));
    expect(detail?.status).toBe("BLOCKED");
  });

  it("17. removeManualBlock restores availability", async () => {
    const vehicle = await createTestVehicle();
    const outcome = await createManualBlock({
      vehicleId: vehicle.id,
      start: futureDate("2033-01-01T00:00:00Z"),
      end: futureDate("2033-01-02T00:00:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    const removed = await removeManualBlock(outcome.blockId);
    expect(removed.ok).toBe(true);

    const detail = await getVehicleDetail(vehicle.id, futureDate("2033-01-01T06:00:00Z"));
    expect(detail?.status).toBe("AVAILABLE");
  });

  it("18. A manual block overlapping a booking is rejected by the constraint, not silently accepted", async () => {
    const vehicle = await createTestVehicle();
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "CONFIRMED",
      pickupAt: futureDate("2033-02-01T00:00:00Z"),
      returnAt: futureDate("2033-02-02T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "BOOKING", "2033-02-01T00:00:00Z", "2033-02-02T01:00:00Z", booking.id);

    const outcome = await createManualBlock({
      vehicleId: vehicle.id,
      start: futureDate("2033-02-01T12:00:00Z"),
      end: futureDate("2033-02-01T18:00:00Z"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("VEHICLE_UNAVAILABLE");
  });
});

describe("images", () => {
  it("19. Images are ordered; setPrimaryImage moves one to first", async () => {
    const vehicle = await createTestVehicle();
    const a = await addVehicleImage(vehicle.id, "https://example.com/a.jpg");
    const b = await addVehicleImage(vehicle.id, "https://example.com/b.jpg");
    const c = await addVehicleImage(vehicle.id, "https://example.com/c.jpg");

    let images = await prisma.vehicleImage.findMany({ where: { vehicleId: vehicle.id }, orderBy: { sortOrder: "asc" } });
    expect(images.map((i) => i.id)).toEqual([a.id, b.id, c.id]);

    await setPrimaryImage(vehicle.id, c.id);

    images = await prisma.vehicleImage.findMany({ where: { vehicleId: vehicle.id }, orderBy: { sortOrder: "asc" } });
    expect(images[0].id).toBe(c.id);
  });

  it("20. Removing an image does not disturb the order of the rest", async () => {
    const vehicle = await createTestVehicle();
    const a = await addVehicleImage(vehicle.id, "https://example.com/a.jpg");
    const b = await addVehicleImage(vehicle.id, "https://example.com/b.jpg");
    const c = await addVehicleImage(vehicle.id, "https://example.com/c.jpg");

    const before = await prisma.vehicleImage.findMany({ where: { vehicleId: vehicle.id }, orderBy: { sortOrder: "asc" } });
    const bSortOrderBefore = before.find((i) => i.id === b.id)?.sortOrder;
    const cSortOrderBefore = before.find((i) => i.id === c.id)?.sortOrder;

    await removeVehicleImage(a.id);

    const after = await prisma.vehicleImage.findMany({ where: { vehicleId: vehicle.id }, orderBy: { sortOrder: "asc" } });
    expect(after.map((i) => i.id)).toEqual([b.id, c.id]);
    expect(after.find((i) => i.id === b.id)?.sortOrder).toBe(bSortOrderBefore);
    expect(after.find((i) => i.id === c.id)?.sortOrder).toBe(cSortOrderBefore);
  });
});

describe("authorisation", () => {
  it("21. /admin/fleet requires STAFF; an unauthenticated request is denied", async () => {
    const outcome = await authorize(undefined, "STAFF");
    expect(outcome.ok).toBe(false);

    const listPageSource = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/fleet/page.tsx"), "utf8");
    expect(listPageSource).toContain('requireAuth("STAFF")');
  });

  it("22. create, update, archive and maintenance actions require MANAGER — a STAFF session is denied", async () => {
    const staff = await prisma.user.create({
      data: {
        email: `fleet-staff-${Date.now()}@example.com`,
        name: "Fleet Staff",
        role: "STAFF",
        passwordHash: await hashPassword("Correct-Horse-Battery-1!"),
      },
    });
    try {
      // roleSatisfies is the exact predicate requireAuth("MANAGER") applies
      // to a resolved session's role — a STAFF session fails it.
      const { roleSatisfies } = await import("../lib/auth/guard");
      expect(roleSatisfies(staff.role, "MANAGER")).toBe(false);

      const actionsSource = fs.readFileSync(path.resolve(process.cwd(), "app/actions/fleet.ts"), "utf8");
      const managerGuardCount = (actionsSource.match(/requireAuth\("MANAGER"\)/g) ?? []).length;
      // Every write action (create/update/archive/bookable/images/maintenance/blocks) guards MANAGER.
      expect(managerGuardCount).toBeGreaterThanOrEqual(12);
    } finally {
      await prisma.user.delete({ where: { id: staff.id } });
    }
  });
});

describe("atomicity", () => {
  it("23. a forced failure after the maintenance record insert but before the block insert leaves ZERO records and ZERO blocks", async () => {
    const vehicle = await createTestVehicle();
    const blocksBefore = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });
    const recordsBefore = await prisma.maintenanceRecord.count({ where: { vehicleId: vehicle.id } });

    vi.spyOn(maintenanceSteps, "insertBlock").mockRejectedValueOnce(new Error("INJECTED_FAILURE_23"));

    await expect(
      createMaintenance({
        vehicleId: vehicle.id,
        type: "REPAIR",
        scheduledAt: futureDate("2033-03-01T00:00:00Z"),
        endAt: futureDate("2033-03-02T00:00:00Z"),
      })
    ).rejects.toThrow("INJECTED_FAILURE_23");

    const blocksAfter = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });
    const recordsAfter = await prisma.maintenanceRecord.count({ where: { vehicleId: vehicle.id } });
    expect(blocksAfter).toBe(blocksBefore);
    expect(recordsAfter).toBe(recordsBefore);
  });
});

describe("fleet identity (P5-P4B)", () => {
  it("P5-P4B-10. fleetNumber is optional — a vehicle without one is still valid", async () => {
    const vehicle = await createTestVehicle();
    const row = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(row.fleetNumber).toBeNull();
  });

  it("P5-P4B-11. two vehicles cannot share a fleetNumber", async () => {
    const fleetNumber = `V-${Math.random().toString(36).slice(2, 8)}`;
    const a = await createTestVehicle();
    await prisma.vehicle.update({ where: { id: a.id }, data: { fleetNumber } });

    const b = await createTestVehicle();
    await expect(prisma.vehicle.update({ where: { id: b.id }, data: { fleetNumber } })).rejects.toThrow();
  });

  it("P5-P4B-12. listVehicles returns fleetNumber and year when present", async () => {
    const fleetNumber = `V-${Math.random().toString(36).slice(2, 8)}`;
    const vehicle = await createTestVehicle();
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { fleetNumber, year: 2022 } });

    const rows = await listVehicles({ search: vehicle.plateNumber }, new Date());
    expect(rows).toHaveLength(1);
    expect(rows[0].fleetNumber).toBe(fleetNumber);
    expect(rows[0].year).toBe(2022);
  });
});

describe("calendar timezone (P5-P4B)", () => {
  it("P5-P4B-13. with no location filter, day boundaries use Settings.businessTimezone, not UTC", async () => {
    const settings = await prisma.settings.findFirst();
    const originalTimezone = settings?.businessTimezone;
    await prisma.settings.updateMany({ data: { businessTimezone: "Pacific/Kiritimati" } });

    try {
      const businessTimezone = await getBusinessTimezone();
      expect(businessTimezone).toBe("Pacific/Kiritimati");

      // Pacific/Kiritimati is UTC+14 — an instant that is still "today" in
      // UTC is already "tomorrow" there, proving the boundary genuinely
      // depends on the configured business timezone, not a UTC fallback.
      const instant = new Date("2050-01-01T23:00:00Z");
      expect(localDayKey(instant, businessTimezone)).toBe("2050-01-02");
      expect(localDayKey(instant, "UTC")).toBe("2050-01-01");
    } finally {
      if (originalTimezone !== undefined) {
        await prisma.settings.updateMany({ data: { businessTimezone: originalTimezone } });
      }
    }
  });
});

// P5-P6A — same spy-and-count method calendar.test.ts's test 11 used, widened
// to every query kind deriveVehicleStatuses/listVehicles issue on the fleet
// prisma client (there is no single "$queryRaw only" story here, since the
// batch also uses ORM findMany calls for vehicles/locations/bookings).
function spyOnFleetQueries() {
  const spies = [
    vi.spyOn(fleetPrisma, "$queryRaw"),
    vi.spyOn(fleetPrisma.vehicle, "findMany"),
    vi.spyOn(fleetPrisma.location, "findMany"),
    vi.spyOn(fleetPrisma.booking, "findMany"),
  ];
  return {
    count: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

describe("batched vehicle status derivation (P5-P6A)", () => {
  it("P5-P6A-1. a vehicle with no blocks returns AVAILABLE", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-01T00:00:00Z");
    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("AVAILABLE");
  });

  it("P5-P6A-2. a vehicle with an ONGOING booking returns RENTED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-02T12:00:00Z");
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      status: "ONGOING",
      pickupAt: futureDate("2034-01-02T00:00:00Z"),
      returnAt: futureDate("2034-01-03T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "BOOKING", "2034-01-02T00:00:00Z", "2034-01-03T01:00:00Z", booking.id);

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("RENTED");
  });

  it("P5-P6A-3. a vehicle with a future CONFIRMED booking covering `now` returns RESERVED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-05T00:00:00Z");
    const pickupAt = futureDate("2034-01-05T00:30:00Z");
    const returnAt = futureDate("2034-01-06T00:30:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt, returnAt });
    const { start, end } = await computeBlockWindow(prisma, locationId, pickupAt, returnAt);
    await insertRawBlock(vehicle.id, "BOOKING", start.toISOString(), end.toISOString(), booking.id);

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("RESERVED");
  });

  it("P5-P6A-4. a vehicle in a maintenance window returns MAINTENANCE", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-10T12:00:00Z");
    await insertRawBlock(vehicle.id, "MAINTENANCE", "2034-01-10T00:00:00Z", "2034-01-11T00:00:00Z");

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("MAINTENANCE");
  });

  it("P5-P6A-5. a vehicle with a MANUAL block returns BLOCKED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-15T06:00:00Z");
    await insertRawBlock(vehicle.id, "MANUAL", "2034-01-15T00:00:00Z", "2034-01-16T00:00:00Z");

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("BLOCKED");
  });

  it("P5-P6A-6. a vehicle with an unexpired HOLD returns BLOCKED", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-20T06:00:00Z");
    const quote = await createTestQuote({
      vehicleId: vehicle.id,
      pickupAt: futureDate("2034-01-20T00:00:00Z"),
      returnAt: futureDate("2034-01-21T00:00:00Z"),
      expiresAt: futureDate("2099-01-01T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "HOLD", "2034-01-20T00:00:00Z", "2034-01-21T00:00:00Z", undefined, quote.id);

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("BLOCKED");
  });

  it("P5-P6A-7. a vehicle with an EXPIRED hold returns AVAILABLE", async () => {
    const vehicle = await createTestVehicle();
    const now = futureDate("2034-01-25T06:00:00Z");
    const quote = await createTestQuote({
      vehicleId: vehicle.id,
      pickupAt: futureDate("2034-01-25T00:00:00Z"),
      returnAt: futureDate("2034-01-26T00:00:00Z"),
      // Compared against Postgres's real now(), not the caller-supplied
      // `now` — must be genuinely in the past.
      expiresAt: futureDate("2020-01-01T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "HOLD", "2034-01-25T00:00:00Z", "2034-01-26T00:00:00Z", undefined, quote.id);

    const statuses = await deriveVehicleStatuses([vehicle.id], now);
    expect(statuses.get(vehicle.id)).toBe("AVAILABLE");
  });

  it("P5-P6A-8. a mixed set of six vehicles, one in each state, all resolve correctly in a single call", async () => {
    const now = futureDate("2034-02-01T12:00:00Z");

    const vAvailable = await createTestVehicle();

    const vRented = await createTestVehicle();
    const rentedBooking = await createTestBooking({
      vehicleId: vRented.id,
      status: "ONGOING",
      pickupAt: futureDate("2034-02-01T00:00:00Z"),
      returnAt: futureDate("2034-02-02T00:00:00Z"),
    });
    await insertRawBlock(vRented.id, "BOOKING", "2034-02-01T00:00:00Z", "2034-02-02T01:00:00Z", rentedBooking.id);

    const vReserved = await createTestVehicle();
    const reservedPickup = futureDate("2034-02-01T12:30:00Z");
    const reservedReturn = futureDate("2034-02-02T12:30:00Z");
    const reservedBooking = await createTestBooking({ vehicleId: vReserved.id, status: "CONFIRMED", pickupAt: reservedPickup, returnAt: reservedReturn });
    const reservedWindow = await computeBlockWindow(prisma, locationId, reservedPickup, reservedReturn);
    await insertRawBlock(vReserved.id, "BOOKING", reservedWindow.start.toISOString(), reservedWindow.end.toISOString(), reservedBooking.id);

    const vMaintenance = await createTestVehicle();
    await insertRawBlock(vMaintenance.id, "MAINTENANCE", "2034-02-01T00:00:00Z", "2034-02-02T00:00:00Z");

    const vBlockedManual = await createTestVehicle();
    await insertRawBlock(vBlockedManual.id, "MANUAL", "2034-02-01T00:00:00Z", "2034-02-02T00:00:00Z");

    const vBlockedHold = await createTestVehicle();
    const holdQuote = await createTestQuote({
      vehicleId: vBlockedHold.id,
      pickupAt: futureDate("2034-02-01T00:00:00Z"),
      returnAt: futureDate("2034-02-02T00:00:00Z"),
      expiresAt: futureDate("2099-01-01T00:00:00Z"),
    });
    await insertRawBlock(vBlockedHold.id, "HOLD", "2034-02-01T00:00:00Z", "2034-02-02T00:00:00Z", undefined, holdQuote.id);

    const ids = [vAvailable.id, vRented.id, vReserved.id, vMaintenance.id, vBlockedManual.id, vBlockedHold.id];
    const statuses = await deriveVehicleStatuses(ids, now);

    expect(statuses.get(vAvailable.id)).toBe("AVAILABLE");
    expect(statuses.get(vRented.id)).toBe("RENTED");
    expect(statuses.get(vReserved.id)).toBe("RESERVED");
    expect(statuses.get(vMaintenance.id)).toBe("MAINTENANCE");
    expect(statuses.get(vBlockedManual.id)).toBe("BLOCKED");
    expect(statuses.get(vBlockedHold.id)).toBe("BLOCKED");
  });

  it("P5-P6A-9. an empty id array returns an empty map without querying", async () => {
    const counter = spyOnFleetQueries();
    const statuses = await deriveVehicleStatuses([], new Date());
    const count = counter.count();
    counter.restore();

    expect(statuses.size).toBe(0);
    expect(count).toBe(0);
  });

  it("P5-P6A-10. an id that does not exist is absent from the map, not thrown on", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";
    const statuses = await deriveVehicleStatuses([nonExistentId], new Date());
    expect(statuses.has(nonExistentId)).toBe(false);
  });

  it("P5-P6A-11. deriveVehicleStatuses agrees with deriveVehicleStatus for every vehicle in the seeded fleet", async () => {
    const activeVehicles = await prisma.vehicle.findMany({
      where: { archivedAt: null },
      select: { id: true, currentLocationId: true },
    });
    const now = new Date();
    const ids = activeVehicles.map((v) => v.id);
    const batched = await deriveVehicleStatuses(ids, now);

    for (const v of activeVehicles) {
      const single = await deriveVehicleStatus(v.id, v.currentLocationId, now);
      expect(batched.get(v.id)).toBe(single);
    }
  });

  it("P5-P6A-12. deriveVehicleStatuses over the entire seeded fleet issues no more than 3 queries", async () => {
    const activeVehicles = await prisma.vehicle.findMany({ where: { archivedAt: null }, select: { id: true } });
    const ids = activeVehicles.map((v) => v.id);

    const counter = spyOnFleetQueries();
    await deriveVehicleStatuses(ids, new Date());
    const count = counter.count();
    counter.restore();

    // Reported in the phase's final report: actual query count vs. vehicle count.
    expect(count).toBeLessThanOrEqual(3);
  });

  it("P5-P6A-13. listVehicles({}, now) over the entire seeded fleet issues no more than 6 queries", async () => {
    const counter = spyOnFleetQueries();
    const rows = await listVehicles({}, new Date());
    const count = counter.count();
    counter.restore();

    expect(rows.length).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(6);
  });

  it("P5-P6A-14. the query count for deriveVehicleStatuses does not grow with the number of vehicles", async () => {
    const activeVehicles = await prisma.vehicle.findMany({ where: { archivedAt: null }, select: { id: true } });
    const allIds = activeVehicles.map((v) => v.id);

    const counterOne = spyOnFleetQueries();
    await deriveVehicleStatuses([allIds[0]], new Date());
    const countAtOne = counterOne.count();
    counterOne.restore();

    const counterAll = spyOnFleetQueries();
    await deriveVehicleStatuses(allIds, new Date());
    const countAtAll = counterAll.count();
    counterAll.restore();

    expect(countAtOne).toBe(countAtAll);
  });
});
