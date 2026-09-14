import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { getFleetCalendar, prisma as calendarPrisma } from "../lib/services/calendar.service";
import { computeBlockWindow } from "../lib/services/availability.service";
import { localDayKey } from "../lib/timezone";
import { authorize } from "../lib/auth/guard";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

let categoryId: string;
let categoryId2: string;
let modelId: string;
let customerId: string;
let locationId: string; // non-UTC, prep=60, turnaround=90
let locationId2: string; // second location, UTC, for location-filter test

const vehicleIds: string[] = [];
const bookingIds: string[] = [];
const quoteIds: string[] = [];

function d(iso: string): Date {
  return new Date(iso);
}

async function createTestVehicle(overrides: { locationId?: string; categoryId?: string } = {}) {
  const catId = overrides.categoryId ?? categoryId;
  let modelIdForVehicle = modelId;
  if (catId !== categoryId) {
    const model = await prisma.vehicleModel.create({
      data: { categoryId: catId, make: "CalTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
    });
    modelIdForVehicle = model.id;
  }
  const loc = overrides.locationId ?? locationId;
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId: modelIdForVehicle,
      plateNumber: `CAL-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: loc,
      currentLocationId: loc,
      dailyRate: BigInt(150000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      minDriverAge: 21,
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
  customerId?: string;
}) {
  const booking = await prisma.booking.create({
    data: {
      reference: `CAL-${Math.random().toString(36).slice(2, 10)}`,
      customerId: overrides.customerId ?? customerId,
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
      driverFullName: "Cal Driver",
      driverPhone: "+639171234567",
      driverEmail: "cal.driver@example.com",
      driverLicenceNumber: "N01-23-999999",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: d("2099-01-01T00:00:00Z"),
    },
  });
  bookingIds.push(booking.id);
  return booking;
}

async function insertRawBlock(
  vehicleId: string,
  blockType: string,
  start: string,
  end: string,
  opts: { bookingId?: string; quoteId?: string } = {}
) {
  if (opts.bookingId) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, booking_id, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::uuid, now())`,
      vehicleId, blockType, start, end, opts.bookingId
    );
  } else if (opts.quoteId) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, quote_id, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::uuid, now())`,
      vehicleId, blockType, start, end, opts.quoteId
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
       VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), now())`,
      vehicleId, blockType, start, end
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
    where: { name: "__test_calendar_category__" },
    update: {},
    create: { name: "__test_calendar_category__" },
  });
  categoryId = category.id;

  const category2 = await prisma.vehicleCategory.upsert({
    where: { name: "__test_calendar_category_2__" },
    update: {},
    create: { name: "__test_calendar_category_2__" },
  });
  categoryId2 = category2.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "CalTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `calendar-test-${Date.now()}@example.com`, name: "Calendar Test Customer" },
  });
  customerId = customer.id;

  const location = await prisma.location.create({
    data: {
      name: `__cal_loc__${Date.now()}`,
      timezone: "Asia/Manila",
      openingHours: {},
      prepMinutes: 60,
      turnaroundMinutes: 90,
      supportsPickup: true,
      supportsDropoff: true,
    },
  });
  locationId = location.id;

  const location2 = await prisma.location.create({
    data: {
      name: `__cal_loc2__${Date.now()}`,
      timezone: "UTC",
      openingHours: {},
      prepMinutes: 30,
      turnaroundMinutes: 60,
      supportsPickup: true,
      supportsDropoff: true,
    },
  });
  locationId2 = location2.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.booking.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.vehicleModel.deleteMany({ where: { categoryId: { in: [categoryId, categoryId2] } } });
  await prisma.location.deleteMany({ where: { id: { in: [locationId, locationId2] } } });
  await prisma.$disconnect();
  await calendarPrisma.$disconnect();
});

describe("data correctness", () => {
  it("1. a block entirely inside the window is returned", async () => {
    const vehicle = await createTestVehicle();
    await insertRawBlock(vehicle.id, "MANUAL", "2040-01-05T00:00:00Z", "2040-01-06T00:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2040-01-01T00:00:00Z"), to: d("2040-01-10T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks).toHaveLength(1);
    expect(row?.blocks[0].clippedStart).toBe(false);
    expect(row?.blocks[0].clippedEnd).toBe(false);
  });

  it("2. a block overlapping only the start edge is returned, marked clipped", async () => {
    const vehicle = await createTestVehicle();
    await insertRawBlock(vehicle.id, "MANUAL", "2040-02-01T00:00:00Z", "2040-02-05T00:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2040-02-03T00:00:00Z"), to: d("2040-02-10T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks).toHaveLength(1);
    expect(row?.blocks[0].clippedStart).toBe(true);
    expect(row?.blocks[0].clippedEnd).toBe(false);
  });

  it("3. a block overlapping only the end edge is returned, marked clipped", async () => {
    const vehicle = await createTestVehicle();
    await insertRawBlock(vehicle.id, "MANUAL", "2040-03-08T00:00:00Z", "2040-03-15T00:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2040-03-01T00:00:00Z"), to: d("2040-03-10T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks).toHaveLength(1);
    expect(row?.blocks[0].clippedStart).toBe(false);
    expect(row?.blocks[0].clippedEnd).toBe(true);
  });

  it("4. a block spanning the whole window is returned, clipped at both ends", async () => {
    const vehicle = await createTestVehicle();
    await insertRawBlock(vehicle.id, "MANUAL", "2040-04-01T00:00:00Z", "2040-04-30T00:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2040-04-05T00:00:00Z"), to: d("2040-04-10T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks).toHaveLength(1);
    expect(row?.blocks[0].clippedStart).toBe(true);
    expect(row?.blocks[0].clippedEnd).toBe(true);
  });

  it("5. a block entirely outside the window is NOT returned", async () => {
    const vehicle = await createTestVehicle();
    await insertRawBlock(vehicle.id, "MANUAL", "2040-05-01T00:00:00Z", "2040-05-02T00:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2040-06-01T00:00:00Z"), to: d("2040-06-10T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks ?? []).toHaveLength(0);
  });

  it("6. an expired HOLD is NOT returned", async () => {
    const vehicle = await createTestVehicle();
    const quote = await createTestQuote({
      vehicleId: vehicle.id,
      pickupAt: d("2040-07-01T00:00:00Z"),
      returnAt: d("2040-07-02T00:00:00Z"),
      // The HOLD-expiry filter compares against Postgres's real now(), not
      // the caller-supplied `now` — must be genuinely in the past.
      expiresAt: d("2020-01-01T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "HOLD", "2040-07-01T00:00:00Z", "2040-07-02T00:00:00Z", { quoteId: quote.id });

    const { vehicles } = await getFleetCalendar({ from: d("2040-07-01T00:00:00Z"), to: d("2040-07-05T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks ?? []).toHaveLength(0);
  });

  it("7. an unexpired HOLD IS returned", async () => {
    const vehicle = await createTestVehicle();
    const quote = await createTestQuote({
      vehicleId: vehicle.id,
      pickupAt: d("2040-08-01T00:00:00Z"),
      returnAt: d("2040-08-02T00:00:00Z"),
      expiresAt: d("2099-01-01T00:00:00Z"),
    });
    await insertRawBlock(vehicle.id, "HOLD", "2040-08-01T00:00:00Z", "2040-08-02T00:00:00Z", { quoteId: quote.id });

    const { vehicles } = await getFleetCalendar({ from: d("2040-08-01T00:00:00Z"), to: d("2040-08-05T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.blocks).toHaveLength(1);
    expect(row?.blocks[0].blockType).toBe("HOLD");
  });

  it("8. an archived vehicle is excluded", async () => {
    const vehicle = await createTestVehicle();
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { archivedAt: new Date() } });

    const { vehicles } = await getFleetCalendar({ from: d("2040-01-01T00:00:00Z"), to: d("2040-12-31T00:00:00Z") });
    expect(vehicles.some((v) => v.vehicleId === vehicle.id)).toBe(false);
  });
});

describe("buffers", () => {
  it("9. a BOOKING block carries both the rental window and the buffered window, differing by prep/turnaround minutes", async () => {
    const vehicle = await createTestVehicle();
    const pickupAt = d("2041-01-10T00:00:00Z");
    const returnAt = d("2041-01-12T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt, returnAt });
    const { start, end } = await computeBlockWindow(prisma, locationId, pickupAt, returnAt);
    await insertRawBlock(vehicle.id, "BOOKING", start.toISOString(), end.toISOString(), { bookingId: booking.id });

    const { vehicles } = await getFleetCalendar({ from: d("2041-01-01T00:00:00Z"), to: d("2041-01-20T00:00:00Z") });
    const block = vehicles.find((v) => v.vehicleId === vehicle.id)?.blocks[0];
    expect(block?.rentalStart.getTime()).toBe(pickupAt.getTime());
    expect(block?.rentalEnd.getTime()).toBe(returnAt.getTime());
    expect(block?.bufferedStart.getTime()).toBe(pickupAt.getTime() - 60 * 60_000); // prepMinutes=60
    expect(block?.bufferedEnd.getTime()).toBe(returnAt.getTime() + 90 * 60_000); // turnaroundMinutes=90
    expect(block?.bufferedStart.getTime()).not.toBe(block?.rentalStart.getTime());
    expect(block?.bufferedEnd.getTime()).not.toBe(block?.rentalEnd.getTime());
  });

  it("10. two back-to-back bookings show adjacent rental windows with OVERLAPPING buffered windows", async () => {
    const vehicle = await createTestVehicle();
    const firstPickup = d("2041-02-01T00:00:00Z");
    const firstReturn = d("2041-02-02T00:00:00Z"); // rental #1 ends here
    const secondPickup = d("2041-02-02T00:00:00Z"); // rental #2 starts exactly when #1 ends
    const secondReturn = d("2041-02-03T00:00:00Z");

    const b1 = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt: firstPickup, returnAt: firstReturn });
    const w1 = await computeBlockWindow(prisma, locationId, firstPickup, firstReturn);
    // Buffered windows would collide if inserted overlapping on the same
    // vehicle (the exclusion constraint forbids it) — a second vehicle
    // stands in for "the next car in the same row group" staff would look
    // at, since the constraint is specifically what a naive rental-window
    // calendar hides: two back-to-back rentals LOOK adjacent but the real
    // buffered occupancy overlaps.
    const vehicle2 = await createTestVehicle();
    const b2 = await createTestBooking({ vehicleId: vehicle2.id, status: "CONFIRMED", pickupAt: secondPickup, returnAt: secondReturn });
    const w2 = await computeBlockWindow(prisma, locationId, secondPickup, secondReturn);

    await insertRawBlock(vehicle.id, "BOOKING", w1.start.toISOString(), w1.end.toISOString(), { bookingId: b1.id });
    await insertRawBlock(vehicle2.id, "BOOKING", w2.start.toISOString(), w2.end.toISOString(), { bookingId: b2.id });

    const { vehicles } = await getFleetCalendar({ from: d("2041-01-25T00:00:00Z"), to: d("2041-02-10T00:00:00Z") });
    const block1 = vehicles.find((v) => v.vehicleId === vehicle.id)?.blocks[0];
    const block2 = vehicles.find((v) => v.vehicleId === vehicle2.id)?.blocks[0];

    expect(block1?.rentalEnd.getTime()).toBe(block2?.rentalStart.getTime()); // rental windows exactly adjacent
    // Buffered windows overlap: block1's buffer extends turnaroundMinutes
    // past its rental end, past block2's buffered start (which begins
    // prepMinutes before its rental start).
    expect(block1!.bufferedEnd.getTime()).toBeGreaterThan(block2!.bufferedStart.getTime());
  });
});

describe("query efficiency", () => {
  it("11. a window containing N vehicles issues ONE block query, not N", async () => {
    const v1 = await createTestVehicle();
    const v2 = await createTestVehicle();
    const v3 = await createTestVehicle();
    await insertRawBlock(v1.id, "MANUAL", "2042-01-01T00:00:00Z", "2042-01-02T00:00:00Z");
    await insertRawBlock(v2.id, "MANUAL", "2042-01-01T00:00:00Z", "2042-01-02T00:00:00Z");
    await insertRawBlock(v3.id, "MANUAL", "2042-01-01T00:00:00Z", "2042-01-02T00:00:00Z");

    const spy = vi.spyOn(calendarPrisma, "$queryRaw");
    await getFleetCalendar({ from: d("2042-01-01T00:00:00Z"), to: d("2042-01-05T00:00:00Z"), locationId });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("derived data", () => {
  it("12. an ONGOING booking past grace is marked isOverdue", async () => {
    const vehicle = await createTestVehicle();
    const pickupAt = d("2043-01-01T00:00:00Z");
    const returnAt = d("2043-01-02T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "ONGOING", pickupAt, returnAt });
    await insertRawBlock(vehicle.id, "BOOKING", pickupAt.toISOString(), "2043-01-02T03:00:00Z", { bookingId: booking.id });

    const now = d("2043-01-02T02:00:00Z"); // well past default 59-minute grace
    const { vehicles } = await getFleetCalendar({ from: d("2042-12-30T00:00:00Z"), to: d("2043-01-05T00:00:00Z") }, now);
    const block = vehicles.find((v) => v.vehicleId === vehicle.id)?.blocks[0];
    expect(block?.isOverdue).toBe(true);
  });

  it("13. a COMPLETED booking is never marked isOverdue", async () => {
    const vehicle = await createTestVehicle();
    const pickupAt = d("2043-02-01T00:00:00Z");
    const returnAt = d("2043-02-02T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "COMPLETED", pickupAt, returnAt });
    await insertRawBlock(vehicle.id, "BOOKING", pickupAt.toISOString(), "2043-02-02T03:00:00Z", { bookingId: booking.id });

    const now = d("2043-02-05T00:00:00Z");
    const { vehicles } = await getFleetCalendar({ from: d("2043-01-30T00:00:00Z"), to: d("2043-02-10T00:00:00Z") }, now);
    const block = vehicles.find((v) => v.vehicleId === vehicle.id)?.blocks[0];
    expect(block?.isOverdue).toBe(false);
  });

  it("14. a BOOKING block carries reference and customer name", async () => {
    const vehicle = await createTestVehicle();
    const pickupAt = d("2043-03-01T00:00:00Z");
    const returnAt = d("2043-03-02T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt, returnAt });
    await insertRawBlock(vehicle.id, "BOOKING", pickupAt.toISOString(), returnAt.toISOString(), { bookingId: booking.id });

    const { vehicles } = await getFleetCalendar({ from: d("2043-02-25T00:00:00Z"), to: d("2043-03-10T00:00:00Z") });
    const block = vehicles.find((v) => v.vehicleId === vehicle.id)?.blocks[0];
    expect(block?.bookingReference).toBe(booking.reference);
    expect(block?.customerName).toBe("Calendar Test Customer");
  });

  it("15. no result contains driverLicenceNumber", async () => {
    const vehicle = await createTestVehicle();
    const pickupAt = d("2043-04-01T00:00:00Z");
    const returnAt = d("2043-04-02T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt, returnAt });
    await insertRawBlock(vehicle.id, "BOOKING", pickupAt.toISOString(), returnAt.toISOString(), { bookingId: booking.id });

    const { vehicles } = await getFleetCalendar({ from: d("2043-03-25T00:00:00Z"), to: d("2043-04-10T00:00:00Z") });
    const serialized = JSON.stringify(vehicles, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialized.toLowerCase()).not.toContain("licence");
    expect(serialized).not.toContain("N01-23-999999");
  });
});

describe("timezone", () => {
  it("16. day boundaries are computed at the location's timezone — a block near midnight lands in the correct column", async () => {
    // Asia/Manila is UTC+8, so 2044-05-01T17:00:00Z is 2044-05-02T01:00 local
    // — the NEXT local calendar day from what the raw UTC date suggests.
    const vehicle = await createTestVehicle();
    const instant = d("2044-05-01T17:00:00Z");
    await insertRawBlock(vehicle.id, "MANUAL", instant.toISOString(), "2044-05-01T18:00:00Z");

    const { vehicles } = await getFleetCalendar({ from: d("2044-04-28T00:00:00Z"), to: d("2044-05-05T00:00:00Z") });
    const row = vehicles.find((v) => v.vehicleId === vehicle.id);
    expect(row?.locationTimezone).toBe("Asia/Manila");
    expect(localDayKey(instant, row!.locationTimezone)).toBe("2044-05-02");
    expect(localDayKey(instant, "UTC")).toBe("2044-05-01");
  });
});

describe("filters", () => {
  it("17. filtering by location returns only that location's vehicles", async () => {
    const vInLoc1 = await createTestVehicle({ locationId });
    const vInLoc2 = await createTestVehicle({ locationId: locationId2 });
    await insertRawBlock(vInLoc1.id, "MANUAL", "2045-01-01T00:00:00Z", "2045-01-02T00:00:00Z");
    await insertRawBlock(vInLoc2.id, "MANUAL", "2045-01-01T00:00:00Z", "2045-01-02T00:00:00Z");

    const { vehicles } = await getFleetCalendar({
      from: d("2045-01-01T00:00:00Z"),
      to: d("2045-01-05T00:00:00Z"),
      locationId: locationId2,
    });
    expect(vehicles.some((v) => v.vehicleId === vInLoc2.id)).toBe(true);
    expect(vehicles.some((v) => v.vehicleId === vInLoc1.id)).toBe(false);
    expect(vehicles.every((v) => v.locationId === locationId2)).toBe(true);
  });

  it("18. filtering by category returns only that category", async () => {
    const vInCat1 = await createTestVehicle({ categoryId });
    const vInCat2 = await createTestVehicle({ categoryId: categoryId2 });

    const { vehicles } = await getFleetCalendar({
      from: d("2045-02-01T00:00:00Z"),
      to: d("2045-02-05T00:00:00Z"),
      categoryId: categoryId2,
    });
    expect(vehicles.some((v) => v.vehicleId === vInCat2.id)).toBe(true);
    expect(vehicles.some((v) => v.vehicleId === vInCat1.id)).toBe(false);
    expect(vehicles.every((v) => v.categoryId === categoryId2)).toBe(true);
  });

  it("19. 'Conflicts and overdue only' returns just those rows", async () => {
    const clean = await createTestVehicle();
    await insertRawBlock(clean.id, "MANUAL", "2045-03-01T00:00:00Z", "2045-03-02T00:00:00Z");

    const overdueVehicle = await createTestVehicle();
    const pickupAt = d("2045-03-01T00:00:00Z");
    const returnAt = d("2045-03-02T00:00:00Z");
    const booking = await createTestBooking({ vehicleId: overdueVehicle.id, status: "ONGOING", pickupAt, returnAt });
    await insertRawBlock(overdueVehicle.id, "BOOKING", pickupAt.toISOString(), "2045-03-02T05:00:00Z", { bookingId: booking.id });

    const now = d("2045-03-02T04:00:00Z");
    const { vehicles } = await getFleetCalendar(
      { from: d("2045-02-25T00:00:00Z"), to: d("2045-03-10T00:00:00Z"), onlyConflictsOrOverdue: true },
      now
    );
    expect(vehicles.some((v) => v.vehicleId === overdueVehicle.id)).toBe(true);
    expect(vehicles.some((v) => v.vehicleId === clean.id)).toBe(false);
  });
});

describe("authorisation", () => {
  it("20. /admin/calendar requires STAFF; unauthenticated is denied", async () => {
    const outcome = await authorize(undefined, "STAFF");
    expect(outcome.ok).toBe(false);

    const pageSource = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/calendar/page.tsx"), "utf8");
    expect(pageSource).toContain('requireAuth("STAFF")');
  });
});
