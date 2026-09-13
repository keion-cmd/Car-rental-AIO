import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import {
  checkOutBooking,
  checkInBooking,
  getVehicleCurrentOdometer,
  bookingSteps,
  prisma as bookingPrisma,
} from "../lib/services/booking.service";
import { authorize } from "../lib/auth/guard";
import { hashPassword } from "../lib/auth/password";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

let categoryId: string;
let modelId: string;
let customerId: string;
let locationId: string;
let staffUserId: string;

const vehicleIds: string[] = [];
const bookingIds: string[] = [];

function futureDate(iso: string): Date {
  return new Date(iso);
}

async function createVehicle(overrides: {
  includedKmPerDay?: number | null;
  extraKmRate?: bigint | null;
} = {}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `CIO-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: locationId,
      currentLocationId: locationId,
      dailyRate: BigInt(100000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      maxRentalDays: null,
      minDriverAge: 21,
      isBookableOnline: true,
      includedKmPerDay: overrides.includedKmPerDay === undefined ? 100 : overrides.includedKmPerDay,
      extraKmRate: overrides.extraKmRate === undefined ? BigInt(1000) : overrides.extraKmRate,
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

async function createBookingRow(overrides: {
  vehicleId: string;
  status?: "PENDING" | "CONFIRMED" | "ONGOING" | "COMPLETED" | "CANCELLED";
  pickupAt?: Date;
  returnAt?: Date;
  rentalDays?: number;
  odometerOut?: number | null;
  fuelOut?: number | null;
  subtotalAmount?: bigint;
  taxAmount?: bigint;
  totalAmount?: bigint;
  securityDeposit?: bigint;
}) {
  const pickupAt = overrides.pickupAt ?? futureDate("2031-01-01T00:00:00Z");
  const returnAt = overrides.returnAt ?? futureDate("2031-01-02T00:00:00Z");
  const subtotalAmount = overrides.subtotalAmount ?? BigInt(100000);
  const taxAmount = overrides.taxAmount ?? BigInt(12000);
  const booking = await prisma.booking.create({
    data: {
      reference: `CIO-${Math.random().toString(36).slice(2, 10)}`,
      customerId,
      vehicleId: overrides.vehicleId,
      pickupLocationId: locationId,
      dropoffLocationId: locationId,
      pickupAt,
      returnAt,
      rentalDays: overrides.rentalDays ?? 1,
      subtotalAmount,
      taxAmount,
      totalAmount: overrides.totalAmount ?? subtotalAmount + taxAmount,
      securityDeposit: overrides.securityDeposit ?? BigInt(50000),
      status: overrides.status ?? "CONFIRMED",
      driverFullName: "Jane Driver",
      driverPhone: "+639171234567",
      driverEmail: "jane.driver@example.com",
      driverLicenceNumber: "N01-23-456789",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: futureDate("2099-01-01T00:00:00Z"),
      odometerOut: overrides.odometerOut,
      fuelOut: overrides.fuelOut,
    },
  });
  bookingIds.push(booking.id);
  if (overrides.subtotalAmount === undefined) {
    await prisma.bookingLineItem.create({
      data: {
        bookingId: booking.id,
        type: "BASE_RATE",
        description: "Base rental rate",
        quantity: 1,
        unitAmount: subtotalAmount,
        totalAmount: subtotalAmount,
        isTaxable: true,
        sortOrder: 0,
        currency: "PHP",
      },
    });
  }
  return booking;
}

async function insertRawBlock(vehicleId: string, bookingId: string, start: string, end: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, booking_id, updated_at)
     VALUES ($1::uuid, 'BOOKING'::"BlockType", tstzrange($2::timestamptz, $3::timestamptz, '[)'), $4::uuid, now())`,
    vehicleId,
    start,
    end,
    bookingId
  );
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_checkinout_category__" },
    update: {},
    create: { name: "__test_checkinout_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "CheckInOutTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `checkinout-test-${Date.now()}@example.com`, name: "Check-in-out Test Customer" },
  });
  customerId = customer.id;

  const location = await prisma.location.create({
    data: { name: `__cio_loc__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 60 },
  });
  locationId = location.id;

  const staff = await prisma.user.create({
    data: {
      email: `checkinout-staff-${Date.now()}@example.com`,
      name: "Counter Staff",
      role: "STAFF",
      passwordHash: await hashPassword("Correct-Horse-Battery-1!"),
    },
  });
  staffUserId = staff.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.booking.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: locationId } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
  await prisma.$disconnect();
  await bookingPrisma.$disconnect();
});

describe("check-out", () => {
  it("1. a CONFIRMED booking checks out, status becomes ONGOING", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "CONFIRMED" });

    const outcome = await checkOutBooking(booking.id, { odometerOut: 1000, fuelOut: 8, staffUserId });
    expect(outcome.ok).toBe(true);

    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updated.status).toBe("ONGOING");
  });

  it("2. values, timestamp and staff id are recorded", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "CONFIRMED" });
    const now = new Date("2031-01-01T09:00:00Z");

    await checkOutBooking(booking.id, { odometerOut: 1500, fuelOut: 6, staffUserId }, { now });

    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updated.odometerOut).toBe(1500);
    expect(updated.fuelOut).toBe(6);
    expect(updated.checkedOutAt?.getTime()).toBe(now.getTime());
    expect(updated.checkedOutById).toBe(staffUserId);
  });

  it("3. the vehicle's odometer is updated", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "CONFIRMED" });

    const before = await getVehicleCurrentOdometer(prisma, vehicle.id);
    expect(before).toBe(0);

    await checkOutBooking(booking.id, { odometerOut: 2000, fuelOut: 8, staffUserId });

    const after = await getVehicleCurrentOdometer(prisma, vehicle.id);
    expect(after).toBe(2000);
  });

  it("4. a PENDING booking is rejected with NOT_CONFIRMED", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "PENDING" });

    const outcome = await checkOutBooking(booking.id, { odometerOut: 1000, fuelOut: 8, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("NOT_CONFIRMED");
  });

  it("5. an already-ONGOING booking is rejected with ALREADY_CHECKED_OUT and writes nothing", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 500, fuelOut: 8 });

    const outcome = await checkOutBooking(booking.id, { odometerOut: 9999, fuelOut: 4, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("ALREADY_CHECKED_OUT");

    const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(unchanged.odometerOut).toBe(500);
    expect(unchanged.fuelOut).toBe(8);
  });

  it("6. odometerOut below the vehicle's reading is rejected", async () => {
    const vehicle = await createVehicle();
    const firstBooking = await createBookingRow({ vehicleId: vehicle.id, status: "CONFIRMED" });
    await checkOutBooking(firstBooking.id, { odometerOut: 5000, fuelOut: 8, staffUserId });
    await checkInBooking(firstBooking.id, { odometerIn: 5100, fuelIn: 8, staffUserId });

    const secondBooking = await createBookingRow({ vehicleId: vehicle.id, status: "CONFIRMED", pickupAt: futureDate("2031-02-01T00:00:00Z"), returnAt: futureDate("2031-02-02T00:00:00Z") });
    const outcome = await checkOutBooking(secondBooking.id, { odometerOut: 4000, fuelOut: 8, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("ODOMETER_BELOW_VEHICLE_READING");
  });
});

describe("check-in", () => {
  it("7. an ONGOING booking checks in, status becomes COMPLETED", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1100, fuelIn: 8, staffUserId });
    expect(outcome.ok).toBe(true);

    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updated.status).toBe("COMPLETED");
  });

  it("8. a booking not ONGOING is rejected", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "PENDING" });

    const outcome = await checkInBooking(booking.id, { odometerIn: 100, fuelIn: 8, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("NOT_ONGOING");
  });

  it("9. an already-COMPLETED booking is rejected and writes no second set of line items", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "COMPLETED", odometerOut: 1000, fuelOut: 8 });
    const before = await prisma.bookingLineItem.count({ where: { bookingId: booking.id } });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1200, fuelIn: 8, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("ALREADY_CHECKED_IN");

    const after = await prisma.bookingLineItem.count({ where: { bookingId: booking.id } });
    expect(after).toBe(before);
  });

  it("10. odometerIn below odometerOut is rejected", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 900, fuelIn: 8, staffUserId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("ODOMETER_BELOW_CHECKOUT");
  });
});

describe("block truncation — the operationally critical part", () => {
  it("11. after check-in, the block is truncated to now + turnaround", async () => {
    const vehicle = await createVehicle();
    const pickupAt = futureDate("2031-03-01T00:00:00Z");
    const returnAt = futureDate("2031-03-05T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 4 });
    await insertRawBlock(vehicle.id, booking.id, pickupAt.toISOString(), new Date(returnAt.getTime() + 60 * 60_000).toISOString());

    const now = futureDate("2031-03-03T00:00:00Z");
    const outcome = await checkInBooking(booking.id, { odometerIn: 1100, fuelIn: 8, staffUserId }, { now });
    expect(outcome.ok).toBe(true);

    const rows = await prisma.$queryRawUnsafe<Array<{ upper: string }>>(
      `SELECT upper(period)::text AS upper FROM vehicle_blocks WHERE booking_id = $1::uuid`,
      booking.id
    );
    expect(rows).toHaveLength(1);
    const expectedEnd = new Date(now.getTime() + 60 * 60_000); // location turnaroundMinutes = 60
    expect(new Date(rows[0].upper).getTime()).toBe(expectedEnd.getTime());
  });

  it("12. EARLY RETURN: checking in a day early frees the vehicle for a window that previously conflicted", async () => {
    const vehicle = await createVehicle();
    const pickupAt = futureDate("2031-04-01T00:00:00Z");
    const returnAt = futureDate("2031-04-05T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 4 });
    await insertRawBlock(vehicle.id, booking.id, pickupAt.toISOString(), new Date(returnAt.getTime() + 60 * 60_000).toISOString());

    // Conflicting window: the previously-booked block (through 2031-04-05
    // +1h) overlaps a hypothetical new rental starting 2031-04-04.
    const conflictStart = "2031-04-04T00:00:00Z";
    const conflictEnd = "2031-04-06T00:00:00Z";
    const overlapsBefore = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM vehicle_blocks WHERE vehicle_id = $1::uuid AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')) AS exists`,
      vehicle.id,
      conflictStart,
      conflictEnd
    );
    expect(overlapsBefore[0].exists).toBe(true);

    // Early return: check in a day early (2031-04-04 instead of 2031-04-05).
    const earlyNow = futureDate("2031-04-04T00:00:00Z");
    const outcome = await checkInBooking(booking.id, { odometerIn: 1200, fuelIn: 8, staffUserId }, { now: earlyNow });
    expect(outcome.ok).toBe(true);

    const overlapsAfter = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM vehicle_blocks WHERE vehicle_id = $1::uuid AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')) AS exists`,
      vehicle.id,
      "2031-04-05T00:00:00Z",
      conflictEnd
    );
    expect(overlapsAfter[0].exists).toBe(false);
  });

  it("13. a late return does not free a window already held by another booking", async () => {
    const vehicle = await createVehicle();
    const pickupAt = futureDate("2031-05-01T00:00:00Z");
    const returnAt = futureDate("2031-05-02T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 1 });
    await insertRawBlock(vehicle.id, booking.id, pickupAt.toISOString(), new Date(returnAt.getTime() + 60 * 60_000).toISOString());

    // Another booking's block, for a different vehicle-independent row —
    // simulate by directly inserting a second, unrelated block referencing
    // no booking, in the immediate turnaround window this late return would
    // otherwise try to encroach on.
    const otherVehicle = await createVehicle();
    const otherStart = "2031-05-02T04:00:00Z";
    const otherEnd = "2031-05-03T00:00:00Z";
    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at) VALUES ($1::uuid, 'MANUAL'::"BlockType", tstzrange($2::timestamptz, $3::timestamptz, '[)'), now())`,
      otherVehicle.id,
      otherStart,
      otherEnd
    );
    const otherBlockBefore = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: otherVehicle.id } });

    // Late return: now is well past returnAt + grace.
    const lateNow = futureDate("2031-05-03T10:00:00Z");
    const outcome = await checkInBooking(booking.id, { odometerIn: 1100, fuelIn: 8, staffUserId }, { now: lateNow });
    expect(outcome.ok).toBe(true);

    const otherBlockAfter = await prisma.vehicleBlock.findUniqueOrThrow({ where: { id: otherBlockBefore.id } });
    expect(otherBlockAfter.updatedAt.getTime()).toBe(otherBlockBefore.updatedAt.getTime());
  });
});

describe("extra charges", () => {
  it("14. returning within grace adds no late fee", async () => {
    const vehicle = await createVehicle();
    const pickupAt = futureDate("2031-06-01T00:00:00Z");
    const returnAt = futureDate("2031-06-02T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 1 });

    const onTimeNow = futureDate("2031-06-02T00:00:00Z");
    const outcome = await checkInBooking(booking.id, { odometerIn: 1050, fuelIn: 8, staffUserId }, { now: onTimeNow });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.ratesMissing.lateFee).toBe(false);
    expect(outcome.lineItemsAdded.some((li) => li.description.toLowerCase().includes("late"))).toBe(false);
  });

  it("15. returning beyond grace adds none (no rate exists in Settings) and the gap is reported", async () => {
    const vehicle = await createVehicle();
    const pickupAt = futureDate("2031-06-05T00:00:00Z");
    const returnAt = futureDate("2031-06-06T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 1 });

    const lateNow = futureDate("2031-06-07T00:00:00Z");
    const outcome = await checkInBooking(booking.id, { odometerIn: 1050, fuelIn: 8, staffUserId }, { now: lateNow });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.ratesMissing.lateFee).toBe(true);
    expect(outcome.lineItemsAdded.some((li) => li.description.toLowerCase().includes("late"))).toBe(false);
  });

  it("16. fuelIn below fuelOut adds no fuel line item (no rate exists), gap reported", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1050, fuelIn: 4, staffUserId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.ratesMissing.fuel).toBe(true);
    expect(outcome.lineItemsAdded.some((li) => li.description.toLowerCase().includes("fuel"))).toBe(false);
  });

  it("17. mileage beyond the allowance adds a line item at the vehicle's extraKmRate", async () => {
    const vehicle = await createVehicle({ includedKmPerDay: 100, extraKmRate: BigInt(2500) });
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, rentalDays: 1 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1150, fuelIn: 8, staffUserId }); // 150km driven, 100 allowed -> 50km over
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    const mileageLine = outcome.lineItemsAdded.find((li) => li.description.toLowerCase().includes("mileage"));
    expect(mileageLine).toBeDefined();
    expect(mileageLine?.totalAmount).toBe(BigInt(50) * BigInt(2500));
  });

  it("18. mileage within the allowance adds nothing", async () => {
    const vehicle = await createVehicle({ includedKmPerDay: 100, extraKmRate: BigInt(2500) });
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, rentalDays: 1 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1050, fuelIn: 8, staffUserId }); // 50km driven, within 100
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.lineItemsAdded.some((li) => li.description.toLowerCase().includes("mileage"))).toBe(false);
  });

  it("19. the recomputed total equals subtotal(all line items) + tax", async () => {
    const vehicle = await createVehicle({ includedKmPerDay: 100, extraKmRate: BigInt(2500) });
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, rentalDays: 1 });

    const outcome = await checkInBooking(booking.id, { odometerIn: 1150, fuelIn: 8, staffUserId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    const lineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: booking.id } });
    const subtotal = lineItems.reduce((sum, li) => sum + li.totalAmount, BigInt(0));
    expect(updated.subtotalAmount).toBe(subtotal);
    expect(updated.totalAmount).toBe(updated.subtotalAmount + updated.taxAmount);
  });

  it("20. securityDeposit is still NOT inside the total after check-in", async () => {
    const vehicle = await createVehicle();
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, securityDeposit: BigInt(75000) });

    await checkInBooking(booking.id, { odometerIn: 1050, fuelIn: 8, staffUserId });

    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updated.securityDeposit).toBe(BigInt(75000));
    expect(updated.totalAmount).toBe(updated.subtotalAmount + updated.taxAmount);
  });
});

describe("atomicity", () => {
  it("21. a forced failure during line-item insertion leaves the booking ONGOING with no partial charges and an untruncated block", async () => {
    const vehicle = await createVehicle({ includedKmPerDay: 100, extraKmRate: BigInt(2500) });
    const pickupAt = futureDate("2031-07-01T00:00:00Z");
    const returnAt = futureDate("2031-07-02T00:00:00Z");
    const booking = await createBookingRow({ vehicleId: vehicle.id, status: "ONGOING", odometerOut: 1000, fuelOut: 8, pickupAt, returnAt, rentalDays: 1 });
    const originalEnd = new Date(returnAt.getTime() + 60 * 60_000).toISOString();
    await insertRawBlock(vehicle.id, booking.id, pickupAt.toISOString(), originalEnd);

    vi.spyOn(bookingSteps, "insertLineItems").mockRejectedValueOnce(new Error("INJECTED_FAILURE_21"));

    await expect(
      checkInBooking(booking.id, { odometerIn: 1150, fuelIn: 8, staffUserId }) // triggers a mileage line item -> insertLineItems is called
    ).rejects.toThrow("INJECTED_FAILURE_21");

    const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(unchanged.status).toBe("ONGOING");
    expect(unchanged.odometerIn).toBeNull();

    const lineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: booking.id } });
    expect(lineItems.some((li) => li.type === "EXTRA_CHARGE")).toBe(false);

    const rows = await prisma.$queryRawUnsafe<Array<{ upper: string }>>(
      `SELECT upper(period)::text AS upper FROM vehicle_blocks WHERE booking_id = $1::uuid`,
      booking.id
    );
    expect(new Date(rows[0].upper).toISOString()).toBe(new Date(originalEnd).toISOString());
  });
});

describe("authorisation", () => {
  it("22. both routes require STAFF; an unauthenticated request is denied", async () => {
    const outcome = await authorize(undefined, "STAFF");
    expect(outcome.ok).toBe(false);

    const checkOutActionSource = fs.readFileSync(path.resolve(process.cwd(), "app/actions/check-in-out.ts"), "utf8");
    expect(checkOutActionSource).toContain('requireAuth("STAFF")');
  });
});
