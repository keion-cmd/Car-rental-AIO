import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { selectVehicle, submitBooking } from "../lib/services/booking-flow.service";
import { prisma as bookingPrisma } from "../lib/services/booking.service";
import { processQueuedNotifications, prisma as notificationPrisma } from "../lib/services/notification.service";
import { renderBookingReceived, type BookingReceivedPayload } from "../lib/notifications/templates/booking-received";
import type { EmailProvider } from "../lib/notifications/provider.interface";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const REF_NOW = new Date();
const FAR_FUTURE_LICENCE_EXPIRY = new Date("2099-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let locA: string;

const vehicleIds: string[] = [];
const customerEmails: string[] = [];
const standaloneNotificationIds: string[] = [];

function dobForAge(age: number, asOf: Date): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear() - age, asOf.getUTCMonth(), asOf.getUTCDate()));
}

async function createVehicle(overrides: { minDriverAge?: number; dailyRate?: bigint } = {}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `NTF-${Math.random().toString(36).slice(2, 10)}`,
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
  const email = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  customerEmails.push(email);
  return {
    driverFullName: "Notif Driver",
    driverEmail: email,
    driverPhone: "+639170000000",
    driverDateOfBirth: dobForAge(30, REF_NOW),
    driverLicenceNumber: "N01-23-999999",
    driverLicenceCountry: "PH",
    driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<EmailProvider> = {}): EmailProvider & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ providerMessageId: "fake-msg-id" }),
    ...overrides,
  } as EmailProvider & { send: ReturnType<typeof vi.fn> };
}

async function createStandaloneNotification(overrides: Record<string, unknown> = {}) {
  const payload: BookingReceivedPayload = {
    reference: "BK-2032-TEST",
    vehicleName: "Toyota Vios",
    pickupAt: "May 1, 2032, 9:00 AM",
    pickupLocationName: "Cebu Branch",
    returnAt: "May 2, 2032, 9:00 AM",
    returnLocationName: "Cebu Branch",
    durationLabel: "1 day",
    lineItems: [{ description: "Base rate", amount: "PHP 1000.00" }],
    subtotal: "PHP 1000.00",
    tax: "PHP 120.00",
    total: "PHP 1120.00",
    securityDeposit: "PHP 500.00",
    driverFullName: "Notif Driver",
    contactEmail: "hello@amihancars.ph",
    contactPhone: "+63 2 8555 0188",
  };
  const row = await notificationPrisma.notification.create({
    data: {
      type: "BOOKING_RECEIVED",
      channel: "EMAIL",
      recipient: "standalone@example.com",
      templateKey: "booking-received",
      payload: payload as unknown as object,
      status: "QUEUED",
      ...overrides,
    },
  });
  standaloneNotificationIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_notif_category__" },
    update: {},
    create: { name: "__test_notif_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "NotifTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const a = await prisma.location.create({
    data: { name: `__notif_loc_a__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locA = a.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Tests run sequentially against a shared table (not per-test isolated
  // rows) — cancel anything still claimable so the next test's
  // processQueuedNotifications call only ever sees rows it created itself.
  await prisma.notification.updateMany({
    where: { status: { in: ["QUEUED", "FAILED", "SENDING"] } },
    data: { status: "CANCELLED" },
  });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { id: { in: standaloneNotificationIds } } });
  await prisma.notification.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
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
  await notificationPrisma.$disconnect();
});

describe("queueing", () => {
  it("1. a successful booking writes exactly one BOOKING_RECEIVED row, status QUEUED, linked to the booking", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-01-01T00:00:00Z");
    const returnAt = new Date("2033-01-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    expect(submitOutcome.ok).toBe(true);
    if (!submitOutcome.ok) throw new Error("expected success");

    const rows = await prisma.notification.findMany({ where: { bookingId: submitOutcome.bookingId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("BOOKING_RECEIVED");
    expect(rows[0].status).toBe("QUEUED");
  });

  it("2. the row's recipient is the driver email from the booking", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-01-05T00:00:00Z");
    const returnAt = new Date("2033-01-06T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const payload = driverPayload();
    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...payload }, REF_NOW);
    if (!submitOutcome.ok) throw new Error("expected success");

    const row = await prisma.notification.findFirstOrThrow({ where: { bookingId: submitOutcome.bookingId } });
    expect(row.recipient).toBe(payload.driverEmail);
  });

  it("3. a FAILED booking writes NO notification row — the transaction rolled it back too", async () => {
    const vehicle = await createVehicle({ minDriverAge: 21 });
    const pickupAt = new Date("2033-01-10T00:00:00Z");
    const returnAt = new Date("2033-01-11T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const payload = driverPayload({ driverDateOfBirth: dobForAge(18, REF_NOW) });
    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...payload }, REF_NOW);
    expect(submitOutcome.ok).toBe(false);

    const rows = await prisma.notification.findMany({ where: { recipient: payload.driverEmail as string } });
    expect(rows).toHaveLength(0);
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

  it("4. payload contains no licence number", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-01-15T00:00:00Z");
    const returnAt = new Date("2033-01-16T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const plaintext = "SECRET-LICENCE-NOTIF-42";
    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverLicenceNumber: plaintext }) },
      REF_NOW
    );
    if (!submitOutcome.ok) throw new Error("expected success");

    const row = await prisma.notification.findFirstOrThrow({ where: { bookingId: submitOutcome.bookingId } });
    expect(JSON.stringify(row.payload)).not.toContain(plaintext);
  });
});

describe("rendering", () => {
  const samplePayload: BookingReceivedPayload = {
    reference: "BK-2033-0099",
    vehicleName: "Honda City",
    pickupAt: "Jan 1, 2033, 9:00 AM",
    pickupLocationName: "Manila Branch",
    returnAt: "Jan 2, 2033, 9:00 AM",
    returnLocationName: "Manila Branch",
    durationLabel: "1 day",
    lineItems: [{ description: "Base rate x1", amount: "PHP 1000.00" }],
    subtotal: "PHP 1000.00",
    tax: "PHP 120.00",
    total: "PHP 1120.00",
    securityDeposit: "PHP 500.00",
    driverFullName: "Sample Driver",
    contactEmail: "hello@amihancars.ph",
    contactPhone: "+63 2 8555 0188",
  };

  it("5. the template renders subject, text and html containing the reference, vehicle and pickup location", () => {
    const rendered = renderBookingReceived(samplePayload);
    for (const field of [rendered.subject, rendered.text, rendered.html]) {
      expect(field).toContain(samplePayload.reference);
    }
    expect(rendered.text).toContain(samplePayload.vehicleName);
    expect(rendered.html).toContain(samplePayload.vehicleName);
    expect(rendered.text).toContain(samplePayload.pickupLocationName);
    expect(rendered.html).toContain(samplePayload.pickupLocationName);
  });

  it("6. the rendered output contains NO licence number", () => {
    const rendered = renderBookingReceived(samplePayload);
    const licencePattern = /licence number|driver.?s licence:/i;
    expect(rendered.text).not.toMatch(/N01-23-999999|SECRET-LICENCE/);
    expect(rendered.html).not.toMatch(/N01-23-999999|SECRET-LICENCE/);
    // Only the generic "bring your licence" instruction is allowed, never a value.
    expect(licencePattern.test(rendered.text)).toBe(false);
  });

  it("7. security deposit appears labelled and separate from the total", () => {
    const rendered = renderBookingReceived(samplePayload);
    expect(rendered.text).toContain(`Security deposit (refundable, not included in total): ${samplePayload.securityDeposit}`);
    expect(rendered.text).toContain(`Total: ${samplePayload.total}`);
    expect(rendered.html).toContain(samplePayload.securityDeposit);
  });
});

describe("processing", () => {
  it("8. processQueuedNotifications sends a QUEUED row and marks it SENT with a providerMessageId and sentAt", async () => {
    const row = await createStandaloneNotification();
    const provider = fakeProvider();

    await processQueuedNotifications(10, provider, REF_NOW);

    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe("SENT");
    expect(updated.providerMessageId).toBe("fake-msg-id");
    expect(updated.sentAt).not.toBeNull();
  });

  it("9. an already-SENT row is skipped — the provider is not called again", async () => {
    const row = await createStandaloneNotification({ status: "SENT", sentAt: REF_NOW, providerMessageId: "old-id" });
    const provider = fakeProvider();

    await processQueuedNotifications(10, provider, REF_NOW);

    expect(provider.send).not.toHaveBeenCalled();
    const unchanged = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.providerMessageId).toBe("old-id");
  });

  it("10. a provider failure marks the row FAILED, records the error and increments attempts", async () => {
    const row = await createStandaloneNotification();
    const provider = fakeProvider({ send: vi.fn().mockRejectedValue(new Error("PROVIDER_DOWN")) });

    await processQueuedNotifications(10, provider, REF_NOW);

    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.error).toContain("PROVIDER_DOWN");
    expect(updated.attempts).toBe(1);
  });

  it("11. a FAILED row with attempts < 3 is retried on the next run", async () => {
    const row = await createStandaloneNotification({ status: "FAILED", attempts: 1, error: "prior failure" });
    const provider = fakeProvider();

    await processQueuedNotifications(10, provider, REF_NOW);

    expect(provider.send).toHaveBeenCalledTimes(1);
    const updated = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("SENT");
  });

  it("12. a FAILED row with attempts = 3 is NOT retried", async () => {
    const row = await createStandaloneNotification({ status: "FAILED", attempts: 3, error: "prior failure" });
    const provider = fakeProvider();

    await processQueuedNotifications(10, provider, REF_NOW);

    expect(provider.send).not.toHaveBeenCalled();
    const unchanged = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.status).toBe("FAILED");
    expect(unchanged.attempts).toBe(3);
  });

  it("13. CONCURRENCY: two parallel processQueuedNotifications runs over the same QUEUED row result in exactly ONE send", async () => {
    await createStandaloneNotification();
    const provider = fakeProvider();

    await Promise.all([processQueuedNotifications(10, provider, REF_NOW), processQueuedNotifications(10, provider, REF_NOW)]);

    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});

describe("isolation", () => {
  it("14. a provider that throws does not prevent the booking from existing", async () => {
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-02-01T00:00:00Z");
    const returnAt = new Date("2033-02-02T00:00:00Z");
    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking({ quoteId: quoteOutcome.quoteId, ...driverPayload() }, REF_NOW);
    if (!submitOutcome.ok) throw new Error("expected success");

    const provider = fakeProvider({ send: vi.fn().mockRejectedValue(new Error("PROVIDER_EXPLODED")) });
    await processQueuedNotifications(10, provider, REF_NOW);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: submitOutcome.bookingId } });
    expect(booking.id).toBe(submitOutcome.bookingId);

    const notification = await prisma.notification.findFirstOrThrow({ where: { bookingId: submitOutcome.bookingId } });
    expect(notification.status).toBe("FAILED");
  });
});
