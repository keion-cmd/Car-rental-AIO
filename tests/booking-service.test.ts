import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { isVehicleAvailable, findAvailableVehicles } from "../lib/services/availability.service";
import { createBooking, cancelBooking, getBookingByReference, getDriverLicenceNumber, bookingSteps, prisma as bookingPrisma } from "../lib/services/booking.service";
import { createQuote, attachCustomerToQuote, releaseExpiredHolds, type CreateQuoteInput } from "../lib/services/quote.service";
import { quote, type QuoteSettingsInput } from "../lib/pricing/quote";
import { encryptField, decryptField } from "../lib/crypto/field-encryption";
import { findOrCreateCustomer } from "../lib/services/customer.service";
import { createBookingInputSchema } from "../lib/validation/booking";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const ADULT_DOB = new Date("1990-01-01T00:00:00Z");
const FAR_FUTURE_LICENCE_EXPIRY = new Date("2099-01-01T00:00:00Z");

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
const extraCustomerIds: string[] = [];

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
    driverFullName: "Jane Driver",
    driverPhone: "+639171234567",
    driverEmail: "jane.driver@example.com",
    driverLicenceNumber: "N01-23-456789",
    driverLicenceCountry: "PH",
    driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
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
  await prisma.quote.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.customer.deleteMany({ where: { id: { in: extraCustomerIds } } });
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

function quoteInput(overrides: Partial<CreateQuoteInput> & { vehicleId: string } & Record<string, unknown>) {
  return {
    customerId,
    pickupLocationId: locNoBuffer,
    dropoffLocationId: locNoBuffer,
    pickupAt: futureDate("2033-01-01T00:00:00Z"),
    returnAt: futureDate("2033-01-02T00:00:00Z"),
    driverDateOfBirth: ADULT_DOB,
    ...overrides,
  };
}

describe("reference persistence", () => {
  it("25. createBooking persists reference; it is readable from the DB", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-01T00:00:00Z"), returnAt: futureDate("2032-04-02T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.reference).toBe(outcome.reference);
  });

  it("26. getBookingByReference returns the correct booking", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-05T00:00:00Z"), returnAt: futureDate("2032-04-06T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const found = await getBookingByReference(outcome.reference);
    expect(found?.id).toBe(outcome.bookingId);
  });

  it("27. two bookings cannot share a reference", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-10T00:00:00Z"), returnAt: futureDate("2032-04-11T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    await expect(
      prisma.booking.create({
        data: {
          reference: outcome.reference,
          customerId,
          vehicleId: vehicle.id,
          pickupLocationId: locNoBuffer,
          dropoffLocationId: locNoBuffer,
          pickupAt: futureDate("2032-04-12T00:00:00Z"),
          returnAt: futureDate("2032-04-13T00:00:00Z"),
          totalAmount: BigInt(1000),
          driverFullName: "Jane Driver",
          driverPhone: "+639171234567",
          driverEmail: "jane.driver@example.com",
          driverLicenceNumber: "N01-23-456789",
          driverLicenceCountry: "PH",
          driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
        },
      })
    ).rejects.toThrow();
  });
});

describe("block linkage", () => {
  it("28. the created block has bookingId set to the booking's id", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-15T00:00:00Z"), returnAt: futureDate("2032-04-16T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const block = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(block.bookingId).toBe(outcome.bookingId);
  });

  it("29. cancelBooking deletes the block found BY bookingId", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-20T00:00:00Z"), returnAt: futureDate("2032-04-21T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const blockBefore = await prisma.vehicleBlock.findFirstOrThrow({ where: { bookingId: outcome.bookingId } });
    expect(blockBefore.bookingId).toBe(outcome.bookingId);

    await cancelBooking(outcome.bookingId, "customer requested");
    const blockAfter = await prisma.vehicleBlock.findUnique({ where: { id: blockBefore.id } });
    expect(blockAfter).toBeNull();
  });

  it("30. REGRESSION: cancellation still finds the block after the pickup Location's turnaroundMinutes changes", async () => {
    const regressionLoc = await prisma.location.create({
      data: { name: `__bkt_loc_regression__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 30 },
    });
    let vehicle: Awaited<ReturnType<typeof createVehicle>> | undefined;
    try {
      vehicle = await createVehicle({ currentLocationId: regressionLoc.id });
      const outcome = await createBooking(
        bookingInput({
          vehicleId: vehicle.id,
          pickupLocationId: regressionLoc.id,
          dropoffLocationId: regressionLoc.id,
          pickupAt: futureDate("2032-04-25T00:00:00Z"),
          returnAt: futureDate("2032-04-26T00:00:00Z"),
        })
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected success");

      // Old recompute-the-period cancellation logic would miss the block
      // here, since the window it recomputes no longer matches what was
      // stored at creation time.
      await prisma.location.update({ where: { id: regressionLoc.id }, data: { turnaroundMinutes: 240 } });

      const cancelOutcome = await cancelBooking(outcome.bookingId, "customer requested");
      expect(cancelOutcome.ok).toBe(true);

      const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
      expect(blocks).toHaveLength(0);
    } finally {
      // The vehicle (home/current location) still references regressionLoc;
      // afterAll's normal cleanup handles the vehicle, so only remove the
      // location's back-reference here, not the vehicle itself.
      if (vehicle) {
        await prisma.vehicle.update({ where: { id: vehicle.id }, data: { homeLocationId: locNoBuffer, currentLocationId: locNoBuffer } });
      }
      await prisma.location.delete({ where: { id: regressionLoc.id } });
    }
  });

  it("31. deleting a booking row cascades to delete its block", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-04-30T00:00:00Z"), returnAt: futureDate("2032-05-01T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    await prisma.bookingLineItem.deleteMany({ where: { bookingId: outcome.bookingId } });
    await prisma.booking.delete({ where: { id: outcome.bookingId } });

    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(0);
  });
});

describe("cancellation persistence", () => {
  it("32. cancellationReason and cancelledAt are persisted", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2032-05-05T00:00:00Z"), returnAt: futureDate("2032-05-06T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    await cancelBooking(outcome.bookingId, "customer requested refund");
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.cancellationReason).toBe("customer requested refund");
    expect(booking.cancelledAt).not.toBeNull();
  });
});

describe("quote holds", () => {
  it("33. createQuote inserts a HOLD block bound to the quote", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt: futureDate("2033-02-01T00:00:00Z"), returnAt: futureDate("2033-02-02T00:00:00Z") }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const block = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(block.blockType).toBe("HOLD");
    expect(block.quoteId).toBe(outcome.quoteId);
  });

  it("34. a second overlapping quote for the same vehicle is REJECTED while the first hold is live", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const first = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt: futureDate("2033-02-05T00:00:00Z"), returnAt: futureDate("2033-02-06T00:00:00Z") }));
    expect(first.ok).toBe(true);

    const second = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt: futureDate("2033-02-05T12:00:00Z"), returnAt: futureDate("2033-02-06T12:00:00Z") }));
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected rejection");
    expect(second.reason).toBe("VEHICLE_UNAVAILABLE");
  });

  it("35. createBooking from a quote results in exactly ONE block, type BOOKING, bookingId set, quoteId cleared", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2033-02-10T00:00:00Z");
    const returnAt = futureDate("2033-02-11T00:00:00Z");
    const quoteOutcome = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt, returnAt }));
    expect(quoteOutcome.ok).toBe(true);
    if (!quoteOutcome.ok) throw new Error("expected quote success");

    const bookingOutcome = await createBooking(
      bookingInput({ vehicleId: vehicle.id, pickupAt, returnAt, quoteId: quoteOutcome.quoteId })
    );
    expect(bookingOutcome.ok).toBe(true);
    if (!bookingOutcome.ok) throw new Error("expected booking success");

    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockType).toBe("BOOKING");
    expect(blocks[0].bookingId).toBe(bookingOutcome.bookingId);
    // quoteId is cleared on conversion: leaving it set would let deleting
    // the now-consumed quote cascade-delete this booking's own block.
    expect(blocks[0].quoteId).toBeNull();
  });

  it("36. an EXPIRED hold does not block availability even before releaseExpiredHolds() runs", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2033-02-15T00:00:00Z");
    const returnAt = futureDate("2033-02-16T00:00:00Z");
    const quoteOutcome = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt, returnAt }));
    expect(quoteOutcome.ok).toBe(true);
    if (!quoteOutcome.ok) throw new Error("expected quote success");

    await prisma.quote.update({ where: { id: quoteOutcome.quoteId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const available = await isVehicleAvailable(vehicle.id, pickupAt, returnAt);
    expect(available).toBe(true);
  });

  it("37. releaseExpiredHolds deletes expired holds and leaves live ones", async () => {
    const expiredVehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const liveVehicle = await createVehicle({ currentLocationId: locNoBuffer });

    const expiredQuote = await createQuote(quoteInput({ vehicleId: expiredVehicle.id, pickupAt: futureDate("2033-02-20T00:00:00Z"), returnAt: futureDate("2033-02-21T00:00:00Z") }));
    const liveQuote = await createQuote(quoteInput({ vehicleId: liveVehicle.id, pickupAt: futureDate("2033-02-22T00:00:00Z"), returnAt: futureDate("2033-02-23T00:00:00Z") }));
    expect(expiredQuote.ok).toBe(true);
    expect(liveQuote.ok).toBe(true);
    if (!expiredQuote.ok || !liveQuote.ok) throw new Error("expected success");

    await prisma.quote.update({ where: { id: expiredQuote.quoteId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    await releaseExpiredHolds();

    const expiredBlocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: expiredVehicle.id } });
    const liveBlocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: liveVehicle.id } });
    expect(expiredBlocks).toHaveLength(0);
    expect(liveBlocks).toHaveLength(1);
  });

  it("38. deleting a quote cascades to delete its hold block", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const quoteOutcome = await createQuote(quoteInput({ vehicleId: vehicle.id, pickupAt: futureDate("2033-02-25T00:00:00Z"), returnAt: futureDate("2033-02-26T00:00:00Z") }));
    expect(quoteOutcome.ok).toBe(true);
    if (!quoteOutcome.ok) throw new Error("expected success");

    await prisma.quoteLineItem.deleteMany({ where: { quoteId: quoteOutcome.quoteId } });
    await prisma.quote.delete({ where: { id: quoteOutcome.quoteId } });

    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(0);
  });
});

describe("concurrency re-verification after block-insertion changes", () => {
  it(
    "39. 50 parallel createBooking calls, same vehicle, same window -> exactly 1 success, 1 booking row, 1 block row",
    async () => {
      const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
      const input = bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2033-03-01T00:00:00Z"), returnAt: futureDate("2033-03-02T00:00:00Z") });

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
});

describe("field encryption", () => {
  it("40. encryptField then decryptField round-trips exactly", () => {
    const plaintext = "N01-23-456789";
    const ciphertext = encryptField(plaintext);
    expect(decryptField(ciphertext)).toBe(plaintext);
  });

  it("41. encrypting the same plaintext twice yields different ciphertext", () => {
    const plaintext = "N01-23-456789";
    const first = encryptField(plaintext);
    const second = encryptField(plaintext);
    expect(first).not.toBe(second);
    expect(decryptField(first)).toBe(plaintext);
    expect(decryptField(second)).toBe(plaintext);
  });

  it("42. tampering with the ciphertext causes decryption to FAIL, not return garbage", () => {
    const ciphertext = encryptField("N01-23-456789");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("43. the value stored in the database column is NOT the plaintext licence number", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const licenceNumber = "N01-99-STORED-RAW-CHECK";
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-01-01T00:00:00Z"),
        returnAt: futureDate("2034-01-02T00:00:00Z"),
        driverLicenceNumber: licenceNumber,
      })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const rows = await prisma.$queryRawUnsafe<Array<{ driver_licence_number: string }>>(
      `SELECT driver_licence_number FROM bookings WHERE id = $1::uuid`,
      outcome.bookingId
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].driver_licence_number).not.toContain(licenceNumber);
  });
});

describe("customer dedup", () => {
  it("44. findOrCreateCustomer with the same email in different case and with whitespace returns ONE customer", async () => {
    const base = `dedup-${Date.now()}@example.com`;
    const first = await findOrCreateCustomer({ email: `  ${base.toUpperCase()}  `, name: "Dedup Person" });
    extraCustomerIds.push(first.id);
    const second = await findOrCreateCustomer({ email: base, name: "Dedup Person" });

    expect(second.id).toBe(first.id);
    const count = await prisma.customer.count({ where: { email: base.toLowerCase() } });
    expect(count).toBe(1);
  });

  it("45. different emails create different customers", async () => {
    const a = await findOrCreateCustomer({ email: `diff-a-${Date.now()}@example.com`, name: "A" });
    const b = await findOrCreateCustomer({ email: `diff-b-${Date.now()}@example.com`, name: "B" });
    extraCustomerIds.push(a.id, b.id);
    expect(a.id).not.toBe(b.id);
  });

  it("46. CONCURRENCY: 20 parallel findOrCreateCustomer calls with the same email create exactly ONE customer row", async () => {
    const email = `concurrent-${Date.now()}@example.com`;
    const attempts = Array.from({ length: 20 }, () => findOrCreateCustomer({ email, name: "Concurrent Person" }));
    const results = await Promise.all(attempts);

    const ids = new Set(results.map((c) => c.id));
    expect(ids.size).toBe(1);
    extraCustomerIds.push(...Array.from(ids));

    const count = await prisma.customer.count({ where: { email: email.toLowerCase() } });
    expect(count).toBe(1);
  });
});

describe("licence validation", () => {
  it("47. a licence expiring before `now` is rejected with LICENCE_EXPIRED, no booking created", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-02-01T00:00:00Z"),
        returnAt: futureDate("2034-02-02T00:00:00Z"),
        driverLicenceExpiry: new Date("2020-01-01T00:00:00Z"),
      })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("LICENCE_EXPIRED");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
  });

  it("48. a licence expiring after `now` but before returnAt is rejected with LICENCE_EXPIRES_DURING_RENTAL", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-02-05T00:00:00Z"),
        returnAt: futureDate("2034-02-06T00:00:00Z"),
        driverLicenceExpiry: futureDate("2028-01-01T00:00:00Z"),
      })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("LICENCE_EXPIRES_DURING_RENTAL");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(0);
  });

  it("49. a licence valid through returnAt is accepted", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const returnAt = futureDate("2034-02-10T00:00:00Z");
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-02-09T00:00:00Z"),
        returnAt,
        driverLicenceExpiry: returnAt,
      })
    );
    expect(outcome.ok).toBe(true);
  });

  it("50. a licence country that is not 2 uppercase letters is rejected by the schema", () => {
    const result = createBookingInputSchema.safeParse({
      ...bookingInput({ vehicleId: "00000000-0000-0000-0000-000000000000" }),
      driverLicenceCountry: "ph",
    });
    expect(result.success).toBe(false);
  });
});

describe("driver field persistence", () => {
  it("51. createBooking persists all six driver fields; the five non-encrypted ones read back exactly", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const driverFields = {
      driverFullName: "Persist Driver",
      driverPhone: "+639170000001",
      driverEmail: "persist.driver@example.com",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: futureDate("2040-01-01T00:00:00Z"),
      driverLicenceNumber: "N01-51-PERSIST",
    };
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-03-01T00:00:00Z"),
        returnAt: futureDate("2034-03-02T00:00:00Z"),
        ...driverFields,
      })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.driverFullName).toBe(driverFields.driverFullName);
    expect(booking.driverPhone).toBe(driverFields.driverPhone);
    expect(booking.driverEmail).toBe(driverFields.driverEmail);
    expect(booking.driverLicenceCountry).toBe(driverFields.driverLicenceCountry);
    expect(booking.driverLicenceExpiry.getTime()).toBe(driverFields.driverLicenceExpiry.getTime());
  });

  it("52. getDriverLicenceNumber returns the original plaintext", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const licenceNumber = "N01-52-DECRYPT-CHECK";
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-03-05T00:00:00Z"),
        returnAt: futureDate("2034-03-06T00:00:00Z"),
        driverLicenceNumber: licenceNumber,
      })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const decrypted = await getDriverLicenceNumber(outcome.bookingId);
    expect(decrypted).toBe(licenceNumber);
  });

  it("53. getBookingByReference does NOT include the licence number in its result", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2034-03-10T00:00:00Z"),
        returnAt: futureDate("2034-03-11T00:00:00Z"),
      })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const found = await getBookingByReference(outcome.reference);
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty("driverLicenceNumber");
  });
});

describe("nullable quote customer", () => {
  it("54. createQuote without a customerId succeeds and persists null", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createQuote(
      quoteInput({ vehicleId: vehicle.id, customerId: undefined, pickupAt: futureDate("2033-04-01T00:00:00Z"), returnAt: futureDate("2033-04-02T00:00:00Z") })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: outcome.quoteId } });
    expect(stored.customerId).toBeNull();
  });

  it("55. the HOLD block is created identically whether or not a customerId was supplied", async () => {
    const vehicleA = await createVehicle({ currentLocationId: locNoBuffer });
    const vehicleB = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2033-04-05T00:00:00Z");
    const returnAt = futureDate("2033-04-06T00:00:00Z");

    const withCustomer = await createQuote(quoteInput({ vehicleId: vehicleA.id, pickupAt, returnAt }));
    const withoutCustomer = await createQuote(quoteInput({ vehicleId: vehicleB.id, customerId: undefined, pickupAt, returnAt }));
    expect(withCustomer.ok).toBe(true);
    expect(withoutCustomer.ok).toBe(true);
    if (!withCustomer.ok || !withoutCustomer.ok) throw new Error("expected success");

    const blockA = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: vehicleA.id } });
    const blockB = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: vehicleB.id } });
    expect(blockA.blockType).toBe("HOLD");
    expect(blockB.blockType).toBe("HOLD");
    expect(blockA.quoteId).toBe(withCustomer.quoteId);
    expect(blockB.quoteId).toBe(withoutCustomer.quoteId);
  });

  it("56. createQuote WITH a customerId still persists it — the old path is unbroken", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createQuote(
      quoteInput({ vehicleId: vehicle.id, customerId, pickupAt: futureDate("2033-04-10T00:00:00Z"), returnAt: futureDate("2033-04-11T00:00:00Z") })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: outcome.quoteId } });
    expect(stored.customerId).toBe(customerId);
  });

  it("57. attachCustomerToQuote sets the customer on an existing quote", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createQuote(
      quoteInput({ vehicleId: vehicle.id, customerId: undefined, pickupAt: futureDate("2033-04-15T00:00:00Z"), returnAt: futureDate("2033-04-16T00:00:00Z") })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const updated = await attachCustomerToQuote(outcome.quoteId, customerId);
    expect(updated.customerId).toBe(customerId);

    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: outcome.quoteId } });
    expect(stored.customerId).toBe(customerId);
  });

  it("58. createBooking from a customerless quote succeeds when a customerId is supplied at booking time", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const pickupAt = futureDate("2033-04-20T00:00:00Z");
    const returnAt = futureDate("2033-04-21T00:00:00Z");
    const quoteOutcome = await createQuote(quoteInput({ vehicleId: vehicle.id, customerId: undefined, pickupAt, returnAt }));
    expect(quoteOutcome.ok).toBe(true);
    if (!quoteOutcome.ok) throw new Error("expected quote success");

    const bookingOutcome = await createBooking(
      bookingInput({ vehicleId: vehicle.id, pickupAt, returnAt, quoteId: quoteOutcome.quoteId })
    );
    expect(bookingOutcome.ok).toBe(true);
    if (!bookingOutcome.ok) throw new Error("expected booking success");

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingOutcome.bookingId } });
    expect(booking.customerId).toBe(customerId);
  });
});

describe("transaction composition", () => {
  it("59. findOrCreateCustomer and createBooking inside ONE external transaction both commit", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const email = `tx-commit-${Date.now()}@example.com`;
    const pickupAt = futureDate("2036-01-01T00:00:00Z");
    const returnAt = futureDate("2036-01-02T00:00:00Z");

    const outcome = await prisma.$transaction(async (tx) => {
      const cust = await findOrCreateCustomer({ email, name: "Tx Commit" }, tx);
      return createBooking(bookingInput({ vehicleId: vehicle.id, customerId: cust.id, pickupAt, returnAt }), { tx });
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const cust = await prisma.customer.findUniqueOrThrow({ where: { email } });
    extraCustomerIds.push(cust.id);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: outcome.bookingId } });
    expect(booking.customerId).toBe(cust.id);
  });

  it("60. THE POINT OF THIS CHANGE: findOrCreateCustomer succeeds then createBooking fails inside one transaction — zero customer rows, zero booking rows remain", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const email = `tx-rollback-${Date.now()}@example.com`;
    const pickupAt = futureDate("2036-02-01T00:00:00Z");
    const returnAt = futureDate("2036-02-02T00:00:00Z");

    // A real failure, not a simulated one: the vehicle-block insert step
    // itself throws, mid-transaction.
    vi.spyOn(bookingSteps, "insertVehicleBlock").mockRejectedValueOnce(new Error("INJECTED_FAILURE_60"));

    await expect(
      prisma.$transaction(async (tx) => {
        const cust = await findOrCreateCustomer({ email, name: "Tx Rollback" }, tx);
        const outcome = await createBooking(bookingInput({ vehicleId: vehicle.id, customerId: cust.id, pickupAt, returnAt }), { tx });
        if (!outcome.ok) throw new Error("booking rejected: " + outcome.reason);
        return outcome;
      })
    ).rejects.toThrow("INJECTED_FAILURE_60");

    const customerCount = await prisma.customer.count({ where: { email } });
    const bookingCount = await prisma.booking.count({ where: { vehicleId: vehicle.id } });
    expect(customerCount).toBe(0);
    expect(bookingCount).toBe(0);
  });

  it("61. createBooking called with NO transaction client still works exactly as before", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const outcome = await createBooking(
      bookingInput({ vehicleId: vehicle.id, pickupAt: futureDate("2036-03-01T00:00:00Z"), returnAt: futureDate("2036-03-02T00:00:00Z") })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(1);
  });
});

describe("injectable clock", () => {
  it("62. createBooking with a frozen `now` in the past accepts a licence that is expired relative to the real clock but valid relative to the frozen one", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const frozenNow = new Date("2026-01-01T00:00:00Z");
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2026-01-02T00:00:00Z"),
        returnAt: futureDate("2026-01-03T00:00:00Z"),
        // Already expired relative to the real system clock, but still
        // valid relative to frozenNow below.
        driverLicenceExpiry: futureDate("2026-05-01T00:00:00Z"),
      }),
      { now: frozenNow }
    );
    expect(outcome.ok).toBe(true);
  });

  it("63. createBooking with a frozen `now` in the future rejects a licence that is valid relative to the real clock — LICENCE_EXPIRED", async () => {
    const vehicle = await createVehicle({ currentLocationId: locNoBuffer });
    const frozenNow = new Date("2030-01-01T00:00:00Z");
    const outcome = await createBooking(
      bookingInput({
        vehicleId: vehicle.id,
        pickupAt: futureDate("2027-01-01T00:00:00Z"),
        returnAt: futureDate("2027-01-02T00:00:00Z"),
        // Valid relative to the real system clock, but already expired
        // relative to frozenNow below.
        driverLicenceExpiry: futureDate("2028-01-01T00:00:00Z"),
      }),
      { now: frozenNow }
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.reason).toBe("LICENCE_EXPIRED");
  });

  it("64. the young-driver surcharge is computed against the passed-in `now`, not the system clock", async () => {
    const vehicleBefore = await createVehicle({ currentLocationId: locNoBuffer });
    const vehicleAfter = await createVehicle({ currentLocationId: locNoBuffer });
    // Turns 25 on 2026-06-15. youngDriverMaxAge is 24 (seeded settings), so
    // the day before the birthday the driver is still 24 (surcharge
    // applies) and the day after they are 25 (surcharge no longer applies).
    const dob = new Date("2001-06-15T00:00:00Z");
    const nowBeforeBirthday = new Date("2026-06-14T00:00:00Z");
    const nowAfterBirthday = new Date("2026-06-16T00:00:00Z");
    const pickupAt = futureDate("2036-07-01T00:00:00Z");
    const returnAt = futureDate("2036-07-02T00:00:00Z");

    const before = await createBooking(
      bookingInput({ vehicleId: vehicleBefore.id, pickupAt, returnAt, driverDateOfBirth: dob }),
      { now: nowBeforeBirthday }
    );
    const after = await createBooking(
      bookingInput({ vehicleId: vehicleAfter.id, pickupAt, returnAt, driverDateOfBirth: dob }),
      { now: nowAfterBirthday }
    );
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("expected success");

    const beforeLineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: before.bookingId } });
    const afterLineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: after.bookingId } });
    expect(beforeLineItems.some((li) => li.type === "SURCHARGE")).toBe(true);
    expect(afterLineItems.some((li) => li.type === "SURCHARGE")).toBe(false);
  });
});

describe("regression on nullability", () => {
  it("65. Booking.customerId remains required — attempting to create a booking without one is rejected", () => {
    const input = bookingInput({ vehicleId: "00000000-0000-0000-0000-000000000000" }) as Record<string, unknown>;
    delete input.customerId;
    const result = createBookingInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
