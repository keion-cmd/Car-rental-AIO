import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isVehicleAvailable, findAvailableVehicles } from "../lib/services/availability.service";
import { createBooking, cancelBooking, bookingSteps, prisma as bookingPrisma } from "../lib/services/booking.service";
import { quote, type QuoteSettingsInput } from "../lib/pricing/quote";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const ADULT_DOB = new Date("1990-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let customerId: string;
let settingsInput: QuoteSettingsInput;

// Locations with distinct, deliberately-chosen buffer settings so each
// availability scenario is unambiguous.
let locNoBuffer: string; // prep=0, turnaround=0 — pure overlap tests
let locTurnaround: string; // prep=0, turnaround=90 — buffer test
let locOther: string; // a second pickup location, for the location-filter test

const vehicleIds: string[] = [];

function futureDate(iso: string): Date {
  return new Date(iso);
}

async function createVehicle(overrides: {
  currentLocationId: string;
  homeLocationId?: string;
  dailyRate?: bigint;
  isBookableOnline?: boolean;
  archivedAt?: Date | null;
}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `BKT-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: overrides.homeLocationId ?? overrides.currentLocationId,
      currentLocationId: overrides.currentLocationId,
      dailyRate: overrides.dailyRate ?? BigInt(100000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      maxRentalDays: null,
      minDriverAge: 21,
      isBookableOnline: overrides.isBookableOnline ?? true,
      archivedAt: overrides.archivedAt ?? null,
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

async function insertRawBlock(vehicleId: string, start: string, end: string, blockType = "BOOKING") {
  await prisma.$executeRawUnsafe(
    `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
     VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), now())`,
    vehicleId,
    blockType,
    start,
    end
  );
}

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    customerId,
    pickupLocationId: locNoBuffer,
    dropoffLocationId: locNoBuffer,
    pickupAt: futureDate("2031-01-01T00:00:00Z"),
    returnAt: futureDate("2031-01-02T00:00:00Z"),
    driverDateOfBirth: ADULT_DOB,
    ...overrides,
  };
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_booking_category__" },
    update: {},
    create: { name: "__test_booking_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "BookingTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `booking-test-${Date.now()}@example.com`, name: "Booking Test Customer" },
  });
  customerId = customer.id;

  const locA = await prisma.location.create({
    data: { name: `__bkt_loc_no_buffer__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locNoBuffer = locA.id;

  const locB = await prisma.location.create({
    data: { name: `__bkt_loc_turnaround__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 90 },
  });
  locTurnaround = locB.id;

  const locC = await prisma.location.create({
    data: { name: `__bkt_loc_other__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locOther = locC.id;

  const settingsRow = await prisma.settings.findFirst();
  if (!settingsRow) {
    throw new Error("no settings row seeded");
  }
  settingsInput = {
    currency: settingsRow.currency,
    taxRateBps: settingsRow.taxRateBps,
    youngDriverMaxAge: settingsRow.youngDriverMaxAge,
    youngDriverSurchargePerDay: settingsRow.youngDriverSurchargePerDay,
    billingGraceMinutes: settingsRow.billingGraceMinutes,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.booking.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: { in: [locNoBuffer, locTurnaround, locOther] } } });
  await prisma.$disconnect();
  await bookingPrisma.$disconnect();
});

describe("availability service", () => {
  it("1. a vehicle with no blocks is available", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const available = await isVehicleAvailable(vehicle.id, futureDate("2031-05-01T00:00:00Z"), futureDate("2031-05-02T00:00:00Z"));
    expect(available).toBe(true);
  });

  it("2. a vehicle with an overlapping BOOKING block is not available", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    await insertRawBlock(vehicle.id, "2031-06-01T08:00:00Z", "2031-06-01T10:00:00Z");
    const available = await isVehicleAvailable(vehicle.id, futureDate("2031-06-01T09:00:00Z"), futureDate("2031-06-01T11:00:00Z"));
    expect(available).toBe(false);
  });

  it("3. a vehicle with an adjacent, non-overlapping block IS available", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    await insertRawBlock(vehicle.id, "2031-06-02T08:00:00Z", "2031-06-02T10:00:00Z");
    const available = await isVehicleAvailable(vehicle.id, futureDate("2031-06-02T10:00:00Z"), futureDate("2031-06-02T12:00:00Z"));
    expect(available).toBe(true);
  });

  it("4. turnaround buffer: a candidate return needing 90min turnaround conflicts with a block starting soon after", async () => {
    const vehicle = await createVehicle({ currentLocationId: locTurnaround });
    // Existing block starts at 15:00. A candidate wanting to return at
    // 14:00 needs a 90min turnaround, i.e. an effective window ending at
    // 15:30 — which overlaps the block starting at 15:00.
    await insertRawBlock(vehicle.id, "2031-06-03T15:00:00Z", "2031-06-03T17:00:00Z");
    const blockedByTurnaround = await isVehicleAvailable(vehicle.id, futureDate("2031-06-03T13:00:00Z"), futureDate("2031-06-03T14:00:00Z"));
    expect(blockedByTurnaround).toBe(false);

    // A return at 13:00 (effective end 14:30) clears the buffer.
    const clearOfTurnaround = await isVehicleAvailable(vehicle.id, futureDate("2031-06-03T12:00:00Z"), futureDate("2031-06-03T13:00:00Z"));
    expect(clearOfTurnaround).toBe(true);
  });

  it("5. findAvailableVehicles returns only vehicles at the requested pickup location", async () => {
    const here = await createVehicle({ currentLocationId: locNoBuffer });
    await createVehicle({ currentLocationId: locOther });
    const results = await findAvailableVehicles(locNoBuffer, futureDate("2031-07-01T00:00:00Z"), futureDate("2031-07-02T00:00:00Z"));
    const ids = results.map((v) => v.id);
    expect(ids).toContain(here.id);
  });

  it("6. findAvailableVehicles excludes a vehicle in MAINTENANCE", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    await insertRawBlock(vehicle.id, "2031-07-03T00:00:00Z", "2031-07-04T00:00:00Z", "MAINTENANCE");
    const results = await findAvailableVehicles(locNoBuffer, futureDate("2031-07-03T00:00:00Z"), futureDate("2031-07-04T00:00:00Z"));
    expect(results.map((v) => v.id)).not.toContain(vehicle.id);
  });

  it("7. findAvailableVehicles excludes archived vehicles", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer, archivedAt: new Date() });
    const results = await findAvailableVehicles(locNoBuffer, futureDate("2031-07-05T00:00:00Z"), futureDate("2031-07-06T00:00:00Z"));
    expect(results.map((v) => v.id)).not.toContain(vehicle.id);
  });

  it("8. findAvailableVehicles excludes vehicles with isBookableOnline = false", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer, isBookableOnline: false });
    const results = await findAvailableVehicles(locNoBuffer, futureDate("2031-07-07T00:00:00Z"), futureDate("2031-07-08T00:00:00Z"));
    expect(results.map((v) => v.id)).not.toContain(vehicle.id);
  });
});

describe("booking creation", () => {
  it("9. a valid request creates exactly one booking, one block, and N line items", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(1);
    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(1);
    const lineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: outcome.bookingId } });
    expect(lineItems.length).toBeGreaterThan(0);
  });

  it("10. the block period includes the turnaround buffer, not just the rental window", async () => {
    const vehicle = await createVehicle({ currentLocationId: locTurnaround });
    const pickupAt = futureDate("2031-08-01T00:00:00Z");
    const returnAt = futureDate("2031-08-02T00:00:00Z");
    const outcome = await createBooking(
      bookingInput({ vehicleId: vehicle.id, pickupLocationId: locTurnaround, dropoffLocationId: locTurnaround, pickupAt, returnAt })
    );
    expect(outcome.ok).toBe(true);

    const rows = await prisma.$queryRawUnsafe<Array<{ upper: string }>>(
      `SELECT upper(period)::text AS upper FROM vehicle_blocks WHERE vehicle_id = $1::uuid`,
      vehicle.id
    );
    expect(rows).toHaveLength(1);
    const storedEnd = new Date(rows[0].upper);
    expect(storedEnd.getTime()).toBe(returnAt.getTime() + 90 * 60_000);
  });

  it("11. booking.totalAmount equals the pricing engine's total for the same inputs", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2031-08-03T00:00:00Z");
    const returnAt = futureDate("2031-08-05T00:00:00Z");
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt, returnAt }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const expected = quote({
      vehicle: {
        dailyRate: vehicle.dailyRate,
        weeklyRate: vehicle.weeklyRate,
        monthlyRate: vehicle.monthlyRate,
        securityDeposit: vehicle.securityDeposit,
        minRentalDays: vehicle.minRentalDays,
        maxRentalDays: vehicle.maxRentalDays,
        minDriverAge: vehicle.minDriverAge,
      },
      pickupLocationId: locNoBuffer,
      returnLocationId: locNoBuffer,
      pickupAt,
      returnAt,
      driverDateOfBirth: ADULT_DOB,
      now: new Date(),
      settings: settingsInput,
      locationPair: null,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error("expected pricing ok");
    expect(outcome.totalAmount).toBe(expected.totalAmount);
  });

  it("12. line items sum exactly to subtotalAmount", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2031-08-10T00:00:00Z"), returnAt: futureDate("2031-08-13T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const lineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: outcome.bookingId } });
    const sum = lineItems.reduce((acc, li) => acc + li.totalAmount, BigInt(0));
    expect(sum).toBe(outcome.subtotalAmount);
  });

  it("13. securityDeposit is stored and is NOT inside totalAmount", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2031-08-15T00:00:00Z"), returnAt: futureDate("2031-08-16T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    expect(outcome.securityDeposit).toBe(vehicle.securityDeposit);
    expect(outcome.totalAmount).toBe(outcome.subtotalAmount + outcome.taxAmount);
  });

  it("14. reference matches BK-YYYY-NNNN and increments on the second booking", async () => {
    const vehicle1 = await createVehicle({ currentLocationId: locNoBuffer });
    const vehicle2 = await createVehicle({ currentLocationId: locNoBuffer });
    const first = await createBooking(bookingInput({ vehicleId: vehicle1.id, pickupAt: futureDate("2031-09-01T00:00:00Z"), returnAt: futureDate("2031-09-02T00:00:00Z") }));
    const second = await createBooking(bookingInput({ vehicleId: vehicle2.id, pickupAt: futureDate("2031-09-03T00:00:00Z"), returnAt: futureDate("2031-09-04T00:00:00Z") }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected success");

    expect(first.reference).toMatch(/^BK-\d{4}-\d{4,}$/);
    expect(second.reference).toMatch(/^BK-\d{4}-\d{4,}$/);
    const firstNum = Number(first.reference.split("-")[2]);
    const secondNum = Number(second.reference.split("-")[2]);
    expect(secondNum).toBe(firstNum + 1);
  });

  it("15. booking_status is PENDING, payment_status UNPAID on creation", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2031-09-10T00:00:00Z"), returnAt: futureDate("2031-09-11T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.status).toBe("PENDING");
    expect(booking.paymentStatus).toBe("UNPAID");
  });
});

describe("price authority", () => {
  it("16. a caller-supplied price/total field is REJECTED by the Zod schema (unknown key), not silently ignored", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking({
      ...bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2031-09-15T00:00:00Z"), returnAt: futureDate("2031-09-16T00:00:00Z") }),
      totalAmount: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("VALIDATION_ERROR");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
  });

  it("17. if vehicle rates change between quote and booking, the booking stores the RE-COMPUTED price", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer, dailyRate: BigInt(100000) });
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { dailyRate: BigInt(250000) } });

    const pickupAt = futureDate("2031-09-20T00:00:00Z");
    const returnAt = futureDate("2031-09-21T00:00:00Z");
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt, returnAt }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const expected = quote({
      vehicle: {
        dailyRate: BigInt(250000),
        weeklyRate: null,
        monthlyRate: null,
        securityDeposit: BigInt(50000),
        minRentalDays: 1,
        maxRentalDays: null,
        minDriverAge: 21,
      },
      pickupLocationId: locNoBuffer,
      returnLocationId: locNoBuffer,
      pickupAt,
      returnAt,
      driverDateOfBirth: ADULT_DOB,
      now: new Date(),
      settings: settingsInput,
      locationPair: null,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error("expected pricing ok");
    expect(outcome.totalAmount).toBe(expected.totalAmount);
    expect(outcome.totalAmount).not.toBe(BigInt(100000) + BigInt(0));
  });

  it("18. pricing rejection (zero-rate vehicle) -> booking NOT created, PRICE_UNAVAILABLE returned, zero rows written", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer, dailyRate: BigInt(0) });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2031-09-25T00:00:00Z"), returnAt: futureDate("2031-09-26T00:00:00Z") }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("PRICE_UNAVAILABLE");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(0);
  });
});

describe("atomicity — the critical section", () => {
  it(
    "19. 50 parallel createBooking calls for the same vehicle and window: exactly 1 succeeds",
    async () => {
      const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
      const input = bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-01-01T00:00:00Z"), returnAt: futureDate("2032-01-02T00:00:00Z") });

      const attempts = Array.from({ length: 50 }, () => createBooking(input));
      const results = await Promise.all(attempts);

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(49);
      for (const f of failures) {
        if (!f.ok) expect(f.reason).toBe("VEHICLE_UNAVAILABLE");
      }

      const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
      const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
      expect(bookings).toHaveLength(1);
      expect(blocks).toHaveLength(1);
    },
    60_000
  );

  it("20. forced failure after booking insert but before block insert leaves ZERO booking rows", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    vi.spyOn(bookingSteps, "insertVehicleBlock").mockRejectedValueOnce(new Error("INJECTED_FAILURE_20"));

    await expect(
      createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-02-01T00:00:00Z"), returnAt: futureDate("2032-02-02T00:00:00Z") }))
    ).rejects.toThrow("INJECTED_FAILURE_20");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
  });

  it("21. forced failure during line-item insert leaves zero bookings and zero blocks", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    vi.spyOn(bookingSteps, "insertLineItems").mockRejectedValueOnce(new Error("INJECTED_FAILURE_21"));

    await expect(
      createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-02-05T00:00:00Z"), returnAt: futureDate("2032-02-06T00:00:00Z") }))
    ).rejects.toThrow("INJECTED_FAILURE_21");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
    expect(blocks).toHaveLength(0);
  });
});

describe("cancellation", () => {
  it("22. cancelBooking sets CANCELLED and deletes the block", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-03-01T00:00:00Z"), returnAt: futureDate("2032-03-02T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const cancelOutcome = await cancelBooking(outcome.bookingId, "customer requested");
    expect(cancelOutcome.ok).toBe(true);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.status).toBe("CANCELLED");
    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(0);
  });

  it("23. after cancellation the vehicle is available for the same window", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2032-03-05T00:00:00Z");
    const returnAt = futureDate("2032-03-06T00:00:00Z");
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt, returnAt }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    await cancelBooking(outcome.bookingId, "customer requested");
    const available = await isVehicleAvailable(vehicle.id, pickupAt, returnAt);
    expect(available).toBe(true);
  });

  it("24. cancelling an already-cancelled booking is a structured rejection, not a second block deletion", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-03-10T00:00:00Z"), returnAt: futureDate("2032-03-11T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const first = await cancelBooking(outcome.bookingId, "first cancel");
    expect(first.ok).toBe(true);

    const second = await cancelBooking(outcome.bookingId, "second cancel");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected rejection");
    expect(second.reason).toBe("ALREADY_CANCELLED");
  });
});
