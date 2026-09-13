import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { selectVehicle, repriceForDriver, submitBooking } from "../lib/services/booking-flow.service";
import { getQuote } from "../lib/services/quote.service";
import { getBookingByReference, bookingSteps, prisma as bookingPrisma } from "../lib/services/booking.service";
import { quote, type QuoteSettingsInput } from "../lib/pricing/quote";
import { createBookingInputSchema } from "../lib/validation/booking";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

// The real wall clock, captured once. nextReference() (booking.service.ts)
// buckets booking references by the YEAR of the DB's own created_at
// (always the real clock, @default(now())), so every `now` passed to
// pricing/age/licence checks here must agree with the real clock too, or
// every booking in a run collides on the same "BK-<year>-0001" reference.
// Pickup/return windows are still set far in the future (2032) for
// isolation from seed data — only `now` itself must track real time.
const REF_NOW = new Date();
const FAR_FUTURE_LICENCE_EXPIRY = new Date("2099-01-01T00:00:00Z");
const PAST_LICENCE_EXPIRY = new Date("2020-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let locA: string; // no buffer, pure overlap tests

const vehicleIds: string[] = [];
const customerEmails: string[] = [];

function dobForAge(age: number, asOf: Date): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear() - age, asOf.getUTCMonth(), asOf.getUTCDate()));
}

async function createVehicle(overrides: { minDriverAge?: number; dailyRate?: bigint } = {}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `BFT-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: locA,
      currentLocationId: locA,
      dailyRate: overrides.dailyRate ?? BigInt(100000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      maxRentalDays: null,
      minDriverAge: overrides.minDriverAge ?? 21,
      isBookableOnline: true,
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

function driverPayload(overrides: Record<string, unknown> = {}) {
  const email = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  customerEmails.push(email);
  return {
    driverFullName: "Flow Driver",
    driverEmail: email,
    driverPhone: "+639170000000",
    driverDateOfBirth: dobForAge(30, REF_NOW),
    driverLicenceNumber: "N01-23-999999",
    driverLicenceCountry: "PH",
    driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
    ...overrides,
  };
}

let settingsInput: QuoteSettingsInput;

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_flow_category__" },
    update: {},
    create: { name: "__test_flow_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "FlowTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const a = await prisma.location.create({
    data: { name: `__bft_loc_a__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locA = a.id;

  const settingsRow = await prisma.settings.findFirst();
  if (!settingsRow) throw new Error("no settings row seeded");
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
  await prisma.quoteLineItem.deleteMany({ where: { quote: { vehicleId: { in: vehicleIds } } } });
  await prisma.quote.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { email: { in: customerEmails } } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: locA } });
  await prisma.$disconnect();
  await bookingPrisma.$disconnect();
});

describe("entering the flow", () => {
  it("1. createQuote with NO customerId from a search result produces a quote and a HOLD block", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-05-01T00:00:00Z");
    const returnAt = new Date("2032-05-02T00:00:00Z");

    const outcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");

    const quoteRow = await prisma.quote.findUniqueOrThrow({ where: { id: outcome.quoteId } });
    expect(quoteRow.customerId).toBeNull();

    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id, quoteId: outcome.quoteId } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockType).toBe("HOLD");
  });

  it("2. a second quote for the same vehicle and overlapping window is rejected with VEHICLE_UNAVAILABLE", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-05-10T00:00:00Z");
    const returnAt = new Date("2032-05-11T00:00:00Z");

    const first = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    expect(first.ok).toBe(true);

    const second = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected rejection");
    expect(second.reason).toBe("VEHICLE_UNAVAILABLE");
  });
});

describe("driver details and re-pricing", () => {
  it("3. driver above youngDriverMaxAge — no surcharge line", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-06-01T00:00:00Z");
    const returnAt = new Date("2032-06-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const outcome = await repriceForDriver(
      {
        quoteId: quoteOutcome.quoteId,
        driverDateOfBirth: dobForAge(settingsInput.youngDriverMaxAge + 10, REF_NOW),
        driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
      },
      REF_NOW
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected reprice success");
    expect(outcome.result.lineItems.some((li) => li.type === "SURCHARGE")).toBe(false);
  });

  it("4. driver at or below youngDriverMaxAge — surcharge line present, total rises", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-06-10T00:00:00Z");
    const returnAt = new Date("2032-06-11T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const older = await repriceForDriver(
      {
        quoteId: quoteOutcome.quoteId,
        driverDateOfBirth: dobForAge(settingsInput.youngDriverMaxAge + 10, REF_NOW),
        driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
      },
      REF_NOW
    );
    const young = await repriceForDriver(
      {
        quoteId: quoteOutcome.quoteId,
        driverDateOfBirth: dobForAge(settingsInput.youngDriverMaxAge, REF_NOW),
        driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
      },
      REF_NOW
    );
    expect(older.ok).toBe(true);
    expect(young.ok).toBe(true);
    if (!older.ok || !young.ok) throw new Error("expected both to succeed");
    expect(young.result.lineItems.some((li) => li.type === "SURCHARGE")).toBe(true);
    expect(young.result.totalAmount).toBeGreaterThan(older.result.totalAmount);
  });

  it("5. driver below the vehicle's minDriverAge — DRIVER_UNDER_AGE, no booking created", async () => {
    const vehicle = await createVehicle({ minDriverAge: 21 });
    const pickupAt = new Date("2032-06-20T00:00:00Z");
    const returnAt = new Date("2032-06-21T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const reprice = await repriceForDriver(
      { quoteId: quoteOutcome.quoteId, driverDateOfBirth: dobForAge(18, REF_NOW), driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY },
      REF_NOW
    );
    expect(reprice.ok).toBe(false);
    if (reprice.ok) throw new Error("expected rejection");
    expect(reprice.reason).toBe("DRIVER_UNDER_AGE");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverDateOfBirth: dobForAge(18, REF_NOW) }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(false);
    if (submitOutcome.ok) throw new Error("expected rejection");
    expect(submitOutcome.reason).toBe("DRIVER_UNDER_AGE");
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });
});

describe("licence", () => {
  it("6. licence already expired — LICENCE_EXPIRED, zero rows written", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-07-01T00:00:00Z");
    const returnAt = new Date("2032-07-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverLicenceExpiry: PAST_LICENCE_EXPIRY }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(false);
    if (submitOutcome.ok) throw new Error("expected rejection");
    expect(submitOutcome.reason).toBe("LICENCE_EXPIRED");
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

  it("7. licence expiring after now but before returnAt — LICENCE_EXPIRES_DURING_RENTAL, zero rows written", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-07-10T00:00:00Z");
    const returnAt = new Date("2032-07-20T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const midRentalExpiry = new Date("2032-07-15T00:00:00Z");
    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverLicenceExpiry: midRentalExpiry }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(false);
    if (submitOutcome.ok) throw new Error("expected rejection");
    expect(submitOutcome.reason).toBe("LICENCE_EXPIRES_DURING_RENTAL");
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

  it("8. licence valid through returnAt — accepted", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-07-25T00:00:00Z");
    const returnAt = new Date("2032-07-26T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(true);
  });

  it("9. the submitted licence number is stored ENCRYPTED", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-08-01T00:00:00Z");
    const returnAt = new Date("2032-08-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const plaintext = "SECRET-LICENCE-42";
    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverLicenceNumber: plaintext }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(true);
    if (!submitOutcome.ok) throw new Error("expected success");

    const raw = await prisma.$queryRawUnsafe<Array<{ driver_licence_number: string }>>(
      `SELECT driver_licence_number FROM bookings WHERE id = $1::uuid`,
      submitOutcome.bookingId
    );
    expect(raw[0].driver_licence_number).not.toContain(plaintext);
  });

  it("10. getBookingByReference does not expose the licence number", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-08-05T00:00:00Z");
    const returnAt = new Date("2032-08-06T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    expect(submitOutcome.ok).toBe(true);
    if (!submitOutcome.ok) throw new Error("expected success");

    const booking = await getBookingByReference(submitOutcome.reference);
    expect(booking).not.toBeNull();
    expect(booking && "driverLicenceNumber" in booking).toBe(false);
  });
});

describe("expiry", () => {
  it("11. a quote past expiresAt cannot create a booking — structured rejection, zero rows written", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-09-01T00:00:00Z");
    const returnAt = new Date("2032-09-02T00:00:00Z");
    // now is far in the past, so expiresAt (now + 30min) is already behind
    // the real wall clock regardless of when the test suite runs.
    const pastNow = new Date("2020-01-01T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      pastNow
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const record = await getQuote(quoteOutcome.quoteId);
    expect(record?.isExpired).toBe(true);

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    expect(submitOutcome.ok).toBe(false);
    if (submitOutcome.ok) throw new Error("expected rejection");
    expect(submitOutcome.reason).toBe("QUOTE_EXPIRED");
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

  it("12. an expired hold does not prevent a different customer quoting the same vehicle and window", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-09-10T00:00:00Z");
    const returnAt = new Date("2032-09-11T00:00:00Z");
    const pastNow = new Date("2020-01-01T00:00:00Z");

    const expiredQuote = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      pastNow
    );
    expect(expiredQuote.ok).toBe(true);

    const freshQuote = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    expect(freshQuote.ok).toBe(true);
  });
});

describe("submission", () => {
  it("13. a valid submission creates exactly one booking, one BOOKING block with bookingId set, and N line items", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-10-01T00:00:00Z");
    const returnAt = new Date("2032-10-03T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    expect(submitOutcome.ok).toBe(true);
    if (!submitOutcome.ok) throw new Error("expected success");

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(1);

    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockType).toBe("BOOKING");
    expect(blocks[0].bookingId).toBe(submitOutcome.bookingId);

    const lineItems = await prisma.bookingLineItem.findMany({ where: { bookingId: submitOutcome.bookingId } });
    expect(lineItems.length).toBeGreaterThan(0);
  });

  it("14. the reference is persisted and retrievable", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-10-10T00:00:00Z");
    const returnAt = new Date("2032-10-11T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    if (!submitOutcome.ok) throw new Error("expected success");

    const found = await getBookingByReference(submitOutcome.reference);
    expect(found?.id).toBe(submitOutcome.bookingId);
  });

  it("15. booking_status PENDING, payment_status UNPAID", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-10-15T00:00:00Z");
    const returnAt = new Date("2032-10-16T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    if (!submitOutcome.ok) throw new Error("expected success");

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: submitOutcome.bookingId } });
    expect(booking.status).toBe("PENDING");
    expect(booking.paymentStatus).toBe("UNPAID");
  });

  it("16. the stored total equals a FRESH quote engine result for the same inputs", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-10-20T00:00:00Z");
    const returnAt = new Date("2032-10-23T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const dob = dobForAge(30, REF_NOW);
    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverDateOfBirth: dob }) },
      REF_NOW
    );
    if (!submitOutcome.ok) throw new Error("expected success");

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
      pickupLocationId: locA,
      returnLocationId: locA,
      pickupAt,
      returnAt,
      driverDateOfBirth: dob,
      now: REF_NOW,
      settings: settingsInput,
      locationPair: null,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error("expected pricing success");
    expect(submitOutcome.totalAmount).toBe(expected.totalAmount);
  });

  it("17. securityDeposit stored and NOT inside totalAmount", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-10-25T00:00:00Z");
    const returnAt = new Date("2032-10-26T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    if (!submitOutcome.ok) throw new Error("expected success");

    expect(submitOutcome.securityDeposit).toBe(vehicle.securityDeposit);
    expect(submitOutcome.totalAmount).toBe(submitOutcome.subtotalAmount + submitOutcome.taxAmount);
  });

  it("18. the HOLD block was CONVERTED, not duplicated — exactly one block for that vehicle afterwards", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-11-01T00:00:00Z");
    const returnAt = new Date("2032-11-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const beforeBlocks = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });
    expect(beforeBlocks).toBe(1);

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    expect(submitOutcome.ok).toBe(true);

    const afterBlocks = await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } });
    expect(afterBlocks).toBe(1);
  });
});

describe("atomicity", () => {
  it("19. THE POINT OF P3-P0B: findOrCreateCustomer succeeds and createBooking then fails — assert ZERO customer rows and ZERO booking rows", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-11-10T00:00:00Z");
    const returnAt = new Date("2032-11-11T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const email = `flow-atomic-${Date.now()}@example.com`;
    customerEmails.push(email);

    // A real failure, not a simulated one, injected on a step that always
    // runs even when converting an existing HOLD (insertVehicleBlock is
    // skipped in that path — see bookingSteps.convertHoldToBooking).
    vi.spyOn(bookingSteps, "insertLineItems").mockRejectedValueOnce(new Error("INJECTED_FAILURE_19"));

    await expect(
      submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: email }) }, REF_NOW)
    ).rejects.toThrow("INJECTED_FAILURE_19");

    expect(await prisma.customer.count({ where: { email } })).toBe(0);
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });
});

describe("price authority", () => {
  it("20. a submission carrying a price/total/amount key is rejected by the strict schema as an unknown key", () => {
    const parsed = createBookingInputSchema.safeParse({
      customerId: "00000000-0000-0000-0000-000000000000",
      vehicleId: "00000000-0000-0000-0000-000000000000",
      pickupLocationId: "00000000-0000-0000-0000-000000000000",
      dropoffLocationId: "00000000-0000-0000-0000-000000000000",
      pickupAt: new Date(),
      returnAt: new Date(),
      driverDateOfBirth: new Date(),
      driverFullName: "Someone",
      driverPhone: "+639170000000",
      driverEmail: "someone@example.com",
      driverLicenceNumber: "X",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: new Date(),
      totalAmount: 999999,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("customer dedup", () => {
  it("21. two bookings with the same email differing only in case attach to ONE customer", async () => {
    const vehicle1 = await createVehicle();
    const vehicle2 = await createVehicle();
    const base = `flow-dedup-${Date.now()}@example.com`;
    customerEmails.push(base);

    const quote1 = await selectVehicle(
      { vehicleId: vehicle1.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt: new Date("2032-11-20T00:00:00Z"), returnAt: new Date("2032-11-21T00:00:00Z") },
      REF_NOW
    );
    const quote2 = await selectVehicle(
      { vehicleId: vehicle2.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt: new Date("2032-11-22T00:00:00Z"), returnAt: new Date("2032-11-23T00:00:00Z") },
      REF_NOW
    );
    if (!quote1.ok || !quote2.ok) throw new Error("expected quotes");

    const first = await submitBooking(
      { quoteId: quote1.quoteId, ...driverPayload({ driverEmail: base.toUpperCase() }) },
      REF_NOW
    );
    const second = await submitBooking({ quoteId: quote2.quoteId, ...driverPayload({ driverEmail: base }) }, REF_NOW);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");

    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: first.bookingId } });
    const b2 = await prisma.booking.findUniqueOrThrow({ where: { id: second.bookingId } });
    expect(b1.customerId).toBe(b2.customerId);
    expect(await prisma.customer.count({ where: { email: base } })).toBe(1);
  });

  it("22. different emails create different customers", async () => {
    const vehicle1 = await createVehicle();
    const vehicle2 = await createVehicle();
    const quote1 = await selectVehicle(
      { vehicleId: vehicle1.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt: new Date("2032-11-25T00:00:00Z"), returnAt: new Date("2032-11-26T00:00:00Z") },
      REF_NOW
    );
    const quote2 = await selectVehicle(
      { vehicleId: vehicle2.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt: new Date("2032-11-27T00:00:00Z"), returnAt: new Date("2032-11-28T00:00:00Z") },
      REF_NOW
    );
    if (!quote1.ok || !quote2.ok) throw new Error("expected quotes");

    const first = await submitBooking({ quoteId: quote1.quoteId, ...driverPayload() }, REF_NOW);
    const second = await submitBooking({ quoteId: quote2.quoteId, ...driverPayload() }, REF_NOW);
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");

    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: first.bookingId } });
    const b2 = await prisma.booking.findUniqueOrThrow({ where: { id: second.bookingId } });
    expect(b1.customerId).not.toBe(b2.customerId);
  });
});

describe("concurrency", () => {
  it("23. 20 parallel submissions of the SAME quote create exactly ONE booking", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2032-12-01T00:00:00Z");
    const returnAt = new Date("2032-12-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const attempts = Array.from({ length: 20 }, () =>
      submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW)
    );
    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    const bookings = await prisma.booking.findMany({ where: { vehicleId: vehicle.id } });
    expect(bookings).toHaveLength(1);
    const blocks = await prisma.vehicleBlock.findMany({ where: { vehicleId: vehicle.id } });
    expect(blocks).toHaveLength(1);
  });
});
