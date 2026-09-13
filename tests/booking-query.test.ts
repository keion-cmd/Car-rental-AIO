import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient, type BookingStatus, type PaymentStatus } from "@prisma/client";
import {
  listBookings,
  getBookingDetail,
  countsForViews,
  computeBookingFlags,
  prisma as queryPrisma,
} from "../lib/services/booking-query.service";
import { cancelBooking, createBooking, updateStaffNotes, getBookingByReference, prisma as bookingPrisma } from "../lib/services/booking.service";
import { isVehicleAvailable, prisma as availabilityPrisma } from "../lib/services/availability.service";
import { queueNotification, prisma as notificationPrisma } from "../lib/services/notification.service";
import { encryptField } from "../lib/crypto/field-encryption";
import { authorize, roleSatisfies } from "../lib/auth/guard";
import { hashPassword } from "../lib/auth/password";
import { createSession, prisma as sessionPrisma } from "../lib/auth/session";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const ADULT_DOB = new Date("1990-01-01T00:00:00Z");
const FAR_FUTURE_LICENCE_EXPIRY = new Date("2099-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let customerId: string;
let locUtc: string; // pickup location, timezone UTC
let locKiritimati: string; // pickup location, timezone Pacific/Kiritimati (UTC+14)

const vehicleIds: string[] = [];
const bookingIds: string[] = [];
const userIds: string[] = [];
let refCounter = 0;

function nextRef(): string {
  refCounter += 1;
  return `BK-TEST-${Date.now()}-${refCounter}`;
}

async function createTestVehicle(currentLocationId: string) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `BQT-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: currentLocationId,
      currentLocationId,
      dailyRate: BigInt(100000),
      securityDeposit: BigInt(50000),
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

interface BookingOverrides {
  vehicleId: string;
  pickupLocationId: string;
  dropoffLocationId?: string;
  pickupAt: Date;
  returnAt: Date;
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  createdAt?: Date;
  customerId?: string;
  customerOverride?: { email: string; name: string; phone?: string };
}

async function createTestBooking(overrides: BookingOverrides) {
  let bookingCustomerId = overrides.customerId ?? customerId;
  if (overrides.customerOverride) {
    const c = await prisma.customer.create({ data: overrides.customerOverride });
    bookingCustomerId = c.id;
  }

  const booking = await prisma.booking.create({
    data: {
      reference: nextRef(),
      customerId: bookingCustomerId,
      vehicleId: overrides.vehicleId,
      pickupLocationId: overrides.pickupLocationId,
      dropoffLocationId: overrides.dropoffLocationId ?? overrides.pickupLocationId,
      pickupAt: overrides.pickupAt,
      returnAt: overrides.returnAt,
      subtotalAmount: BigInt(100000),
      taxAmount: BigInt(12000),
      securityDeposit: BigInt(50000),
      rentalDays: 1,
      totalAmount: BigInt(112000),
      status: overrides.status ?? "PENDING",
      paymentStatus: overrides.paymentStatus ?? "UNPAID",
      driverFullName: "Test Driver",
      driverPhone: "+639171234567",
      driverEmail: "driver@example.com",
      driverLicenceNumber: encryptField("N01-23-456789"),
      driverLicenceCountry: "PH",
      driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  bookingIds.push(booking.id);
  return booking;
}

async function sessionFor(role: "STAFF" | "MANAGER"): Promise<string> {
  const passwordHash = await hashPassword("Correct-Horse-Battery-1!");
  const user = await prisma.user.create({
    data: {
      email: `booking-query-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      name: "Test User",
      role,
      isActive: true,
      passwordHash,
    },
  });
  userIds.push(user.id);
  const session = await createSession(user.id, {}, new Date());
  return session.rawToken;
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_booking_query_category__" },
    update: {},
    create: { name: "__test_booking_query_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "QueryTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `booking-query-test-${Date.now()}@example.com`, name: "Query Test Customer" },
  });
  customerId = customer.id;

  const locA = await prisma.location.create({
    data: { name: `__bqt_loc_utc__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locUtc = locA.id;

  const locB = await prisma.location.create({
    data: {
      name: `__bqt_loc_kiritimati__${Date.now()}`,
      timezone: "Pacific/Kiritimati",
      openingHours: {},
      prepMinutes: 0,
      turnaroundMinutes: 0,
    },
  });
  locKiritimati = locB.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.location.deleteMany({ where: { id: { in: [locUtc, locKiritimati] } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.$disconnect();
  await queryPrisma.$disconnect();
  await bookingPrisma.$disconnect();
  await availabilityPrisma.$disconnect();
  await sessionPrisma.$disconnect();
  await notificationPrisma.$disconnect();
});

describe("computeBookingFlags: derived flags", () => {
  const GRACE = 59;

  it("1. ONGOING with returnAt in the past beyond grace -> isOverdue true", () => {
    const now = new Date("2030-01-10T12:00:00Z");
    const returnAt = new Date("2030-01-10T10:00:00Z"); // 120min ago, grace is 59min
    const flags = computeBookingFlags(
      { status: "ONGOING", paymentStatus: "UNPAID", pickupAt: new Date("2030-01-08T00:00:00Z"), returnAt, createdAt: new Date("2030-01-01T00:00:00Z") },
      "UTC",
      now,
      GRACE
    );
    expect(flags.isOverdue).toBe(true);
  });

  it("2. ONGOING with returnAt in the past but WITHIN grace -> isOverdue false", () => {
    const now = new Date("2030-01-10T10:30:00Z");
    const returnAt = new Date("2030-01-10T10:00:00Z"); // 30min ago, grace is 59min
    const flags = computeBookingFlags(
      { status: "ONGOING", paymentStatus: "UNPAID", pickupAt: new Date("2030-01-08T00:00:00Z"), returnAt, createdAt: new Date("2030-01-01T00:00:00Z") },
      "UTC",
      now,
      GRACE
    );
    expect(flags.isOverdue).toBe(false);
  });

  it("3. COMPLETED with returnAt long past -> isOverdue FALSE", () => {
    const now = new Date("2030-01-10T12:00:00Z");
    const returnAt = new Date("2020-01-01T00:00:00Z");
    const flags = computeBookingFlags(
      { status: "COMPLETED", paymentStatus: "PAID", pickupAt: new Date("2019-12-30T00:00:00Z"), returnAt, createdAt: new Date("2019-12-01T00:00:00Z") },
      "UTC",
      now,
      GRACE
    );
    expect(flags.isOverdue).toBe(false);
  });

  it("4. CONFIRMED with pickupAt today at the pickup location -> isStartingToday true", () => {
    const now = new Date("2030-06-15T08:00:00Z");
    const pickupAt = new Date("2030-06-15T14:00:00Z");
    const flags = computeBookingFlags(
      { status: "CONFIRMED", paymentStatus: "UNPAID", pickupAt, returnAt: new Date("2030-06-16T14:00:00Z"), createdAt: new Date("2030-06-01T00:00:00Z") },
      "UTC",
      now,
      GRACE
    );
    expect(flags.isStartingToday).toBe(true);
  });

  it("5. pickupAt today in UTC but NOT today at a non-UTC pickup location -> isStartingToday false", () => {
    // now: 2030-06-15T23:00Z -> at Pacific/Kiritimati (UTC+14) that instant reads 2030-06-16 local: "today" there is June 16.
    // pickupAt: 2030-06-15T01:00Z -> same UTC calendar day as now (June 15), but at Kiritimati reads June 15 local: NOT June 16.
    const now = new Date("2030-06-15T23:00:00Z");
    const pickupAt = new Date("2030-06-15T01:00:00Z");
    const flags = computeBookingFlags(
      { status: "CONFIRMED", paymentStatus: "UNPAID", pickupAt, returnAt: new Date("2030-06-16T01:00:00Z"), createdAt: new Date("2030-06-01T00:00:00Z") },
      "Pacific/Kiritimati",
      now,
      GRACE
    );
    expect(flags.isStartingToday).toBe(false);
  });

  it("6. PENDING created 3h ago -> needsAttention true", () => {
    const now = new Date("2030-01-01T03:00:00Z");
    const createdAt = new Date("2030-01-01T00:00:00Z");
    const flags = computeBookingFlags(
      { status: "PENDING", paymentStatus: "UNPAID", pickupAt: new Date("2030-01-05T00:00:00Z"), returnAt: new Date("2030-01-06T00:00:00Z"), createdAt },
      "UTC",
      now,
      GRACE
    );
    expect(flags.needsAttention).toBe(true);
  });

  it("7. PENDING created 10min ago -> needsAttention false", () => {
    const now = new Date("2030-01-01T00:10:00Z");
    const createdAt = new Date("2030-01-01T00:00:00Z");
    const flags = computeBookingFlags(
      { status: "PENDING", paymentStatus: "UNPAID", pickupAt: new Date("2030-01-05T00:00:00Z"), returnAt: new Date("2030-01-06T00:00:00Z"), createdAt },
      "UTC",
      now,
      GRACE
    );
    expect(flags.needsAttention).toBe(false);
  });

  it("8. all flags computed against the passed-in now, not the system clock", () => {
    const createdAt = new Date("2030-01-01T00:00:00Z");
    const booking = {
      status: "PENDING" as const,
      paymentStatus: "UNPAID" as const,
      pickupAt: new Date("2030-01-05T00:00:00Z"),
      returnAt: new Date("2030-01-06T00:00:00Z"),
      createdAt,
    };
    const earlyNow = new Date("2030-01-01T00:10:00Z"); // 10min later
    const lateNow = new Date("2030-01-01T05:00:00Z"); // 5h later
    const early = computeBookingFlags(booking, "UTC", earlyNow, GRACE);
    const late = computeBookingFlags(booking, "UTC", lateNow, GRACE);
    expect(early.needsAttention).toBe(false);
    expect(late.needsAttention).toBe(true);
  });
});

describe("listBookings / countsForViews: filtering, search, pagination", () => {
  const now = new Date("2031-06-01T12:00:00Z");

  it("9 & 10. each saved view returns only matching bookings, and counts match", async () => {
    const vehicle = await createTestVehicle(locUtc);
    await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-06-01T15:00:00Z"), returnAt: new Date("2031-06-02T15:00:00Z"), status: "CONFIRMED" });
    await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-05-25T00:00:00Z"), returnAt: new Date("2031-06-01T10:00:00Z"), status: "ONGOING" }); // overdue: returnAt 2h before now, grace default from settings (>0 typically)
    await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-06-10T00:00:00Z"), returnAt: new Date("2031-06-11T00:00:00Z"), status: "PENDING", createdAt: new Date("2031-06-01T08:00:00Z") }); // 4h old pending

    const [needsAttention, ongoing, pending, all] = await Promise.all([
      listBookings({ view: "needsAttention", pickupLocationId: locUtc }, {}, now),
      listBookings({ view: "ongoing", pickupLocationId: locUtc }, {}, now),
      listBookings({ view: "pending", pickupLocationId: locUtc }, {}, now),
      listBookings({ view: "all", pickupLocationId: locUtc }, {}, now),
    ]);

    expect(ongoing.rows.every((r) => r.status === "ONGOING")).toBe(true);
    expect(pending.rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(needsAttention.rows.every((r) => r.needsAttention)).toBe(true);
    expect(needsAttention.rows.length).toBeGreaterThan(0);

    const counts = await countsForViews({ pickupLocationId: locUtc }, now);
    expect(counts.ongoing).toBe(ongoing.rows.length);
    expect(counts.pending).toBe(pending.rows.length);
    expect(counts.needsAttention).toBe(needsAttention.rows.length);
    expect(counts.all).toBe(all.rows.length);
  });

  it("11. search by reference finds the booking", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-07-01T00:00:00Z"), returnAt: new Date("2031-07-02T00:00:00Z") });

    const result = await listBookings({ search: booking.reference }, {}, now);
    expect(result.rows.some((r) => r.id === booking.id)).toBe(true);
  });

  it("12. search by customer email finds it, case-insensitively", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const email = `Case-Sensitive-${Date.now()}@Example.com`;
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-07-05T00:00:00Z"),
      returnAt: new Date("2031-07-06T00:00:00Z"),
      customerOverride: { email, name: "Case Test" },
    });

    const result = await listBookings({ search: email.toLowerCase() }, {}, now);
    expect(result.rows.some((r) => r.id === booking.id)).toBe(true);
  });

  it("13. search by plate finds it", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-07-10T00:00:00Z"), returnAt: new Date("2031-07-11T00:00:00Z") });

    const result = await listBookings({ search: vehicle.plateNumber }, {}, now);
    expect(result.rows.some((r) => r.id === booking.id)).toBe(true);
  });

  it("14. a status filter excludes other statuses", async () => {
    const vehicle = await createTestVehicle(locUtc);
    await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-08-01T00:00:00Z"), returnAt: new Date("2031-08-02T00:00:00Z"), status: "CANCELLED" });

    const result = await listBookings({ status: "CANCELLED", pickupLocationId: locUtc }, {}, now);
    expect(result.rows.every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("15. pagination returns stable, non-overlapping pages", async () => {
    const vehicle = await createTestVehicle(locUtc);
    for (let i = 0; i < 5; i++) {
      await createTestBooking({
        vehicleId: vehicle.id,
        pickupLocationId: locUtc,
        pickupAt: new Date(`2031-09-0${i + 1}T00:00:00Z`),
        returnAt: new Date(`2031-09-0${i + 2}T00:00:00Z`),
      });
    }

    const page1 = await listBookings({ pickupLocationId: locUtc, sortBy: "pickup", sortDir: "asc" }, { limit: 2 }, now);
    expect(page1.rows.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listBookings({ pickupLocationId: locUtc, sortBy: "pickup", sortDir: "asc" }, { limit: 2, cursor: page1.nextCursor! }, now);
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    expect(page2.rows.every((r) => !page1Ids.has(r.id))).toBe(true);
    expect(page2.rows.length).toBeGreaterThan(0);
  });
});

describe("security: driver licence number never leaks", () => {
  const now = new Date("2031-06-01T12:00:00Z");

  it("16. listBookings never returns driverLicenceNumber", async () => {
    const vehicle = await createTestVehicle(locUtc);
    await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-10-01T00:00:00Z"), returnAt: new Date("2031-10-02T00:00:00Z") });

    const result = await listBookings({ pickupLocationId: locUtc }, {}, now);
    for (const row of result.rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "driverLicenceNumber")).toBe(false);
    }
  });

  it("17. getBookingDetail never returns driverLicenceNumber", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-10-05T00:00:00Z"), returnAt: new Date("2031-10-06T00:00:00Z") });

    const detail = await getBookingDetail(booking.id, now);
    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("N01-23-456789");
    expect(Object.prototype.hasOwnProperty.call(detail!.driver, "licenceNumber")).toBe(false);
  });
});

describe("authorisation", () => {
  it("18. /admin/bookings and /admin/bookings/[id] require STAFF", () => {
    const listSource = fs.readFileSync(path.resolve(process.cwd(), "app/admin/bookings/page.tsx"), "utf8");
    const detailSource = fs.readFileSync(path.resolve(process.cwd(), "app/admin/bookings/[id]/page.tsx"), "utf8");
    expect(listSource).toContain('requireAuth("STAFF")');
    expect(detailSource).toContain('requireAuth("STAFF")');
  });

  it("19. the cancel action requires MANAGER — a STAFF session is denied", async () => {
    const actionSource = fs.readFileSync(path.resolve(process.cwd(), "app/actions/bookings.ts"), "utf8");
    expect(actionSource).toContain('requireAuth("MANAGER")');

    const staffToken = await sessionFor("STAFF");
    const managerToken = await sessionFor("MANAGER");

    const staffOutcome = await authorize(staffToken, "MANAGER");
    const managerOutcome = await authorize(managerToken, "MANAGER");

    expect(staffOutcome.ok).toBe(false);
    expect(managerOutcome.ok).toBe(true);
    expect(roleSatisfies("STAFF", "MANAGER")).toBe(false);
    expect(roleSatisfies("MANAGER", "MANAGER")).toBe(true);
  });

  it("P5-P4B-1. amountPaid defaults to 0 on a newly created booking", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-11-01T00:00:00Z"), returnAt: new Date("2031-11-02T00:00:00Z") });
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.amountPaid).toBe(BigInt(0));
  });

  it("P5-P4B-2. balanceDue equals totalAmount when amountPaid is 0", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-11-05T00:00:00Z"), returnAt: new Date("2031-11-06T00:00:00Z") });
    const detail = await getBookingDetail(booking.id, new Date("2031-06-01T12:00:00Z"));
    expect(detail?.balanceDue).toBe(detail?.totalAmount);
  });

  it("P5-P4B-3. balanceDue equals totalAmount - amountPaid when amountPaid is set directly", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-11-10T00:00:00Z"), returnAt: new Date("2031-11-11T00:00:00Z") });
    await prisma.booking.update({ where: { id: booking.id }, data: { amountPaid: BigInt(50000) } });
    const detail = await getBookingDetail(booking.id, new Date("2031-06-01T12:00:00Z"));
    expect(detail?.balanceDue).toBe(detail!.totalAmount - BigInt(50000));
  });

  it("P5-P4B-4. Settings.businessTimezone is readable and non-empty", async () => {
    const settings = await prisma.settings.findFirst({ select: { businessTimezone: true } });
    expect(settings?.businessTimezone).toBeTruthy();
    expect((settings?.businessTimezone ?? "").length).toBeGreaterThan(0);
  });

  it("P5-P4B-5. a booking with paymentStatus FAILED is flagged needsAttention", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-12-01T00:00:00Z"),
      returnAt: new Date("2031-12-02T00:00:00Z"),
      status: "CONFIRMED",
      paymentStatus: "FAILED",
    });
    const detail = await getBookingDetail(booking.id, new Date("2031-06-01T12:00:00Z"));
    expect(detail?.needsAttention).toBe(true);
  });

  it("P5-P4B-6. a PAID booking that is neither overdue nor stale PENDING is not flagged", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-12-05T00:00:00Z"),
      returnAt: new Date("2031-12-06T00:00:00Z"),
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
    const detail = await getBookingDetail(booking.id, new Date("2031-06-01T12:00:00Z"));
    expect(detail?.needsAttention).toBe(false);
  });

  it("P5-P4B-7. updateStaffNotes persists and is readable on the detail", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-12-10T00:00:00Z"), returnAt: new Date("2031-12-11T00:00:00Z") });
    await updateStaffNotes(booking.id, "Customer requested extra blanket.");
    const detail = await getBookingDetail(booking.id, new Date("2031-06-01T12:00:00Z"));
    expect(detail?.staffNotes).toBe("Customer requested extra blanket.");
  });

  it("P5-P4B-8. staffNotes is NOT present in any notification payload", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-12-15T00:00:00Z"), returnAt: new Date("2031-12-16T00:00:00Z") });
    await updateStaffNotes(booking.id, "Internal-only secret note.");

    await queueNotification({
      type: "BOOKING_RECEIVED",
      channel: "EMAIL",
      recipient: "driver@example.com",
      bookingId: booking.id,
      templateKey: "booking-received",
      payload: { reference: booking.reference },
    });

    const notification = await prisma.notification.findFirst({ where: { bookingId: booking.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(notification?.payload)).not.toContain("Internal-only secret note.");
  });

  it("P5-P4B-9. staffNotes is NOT returned by getBookingByReference", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const booking = await createTestBooking({ vehicleId: vehicle.id, pickupLocationId: locUtc, pickupAt: new Date("2031-12-20T00:00:00Z"), returnAt: new Date("2031-12-21T00:00:00Z") });
    await updateStaffNotes(booking.id, "Should never be public.");

    const publicBooking = await getBookingByReference(booking.reference);
    expect(publicBooking).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(publicBooking, "staffNotes")).toBe(false);
  });

  it("20. cancelling via the action releases the vehicle block, and the vehicle becomes available again", async () => {
    const vehicle = await createTestVehicle(locUtc);
    const pickupAt = new Date("2032-01-01T00:00:00Z");
    const returnAt = new Date("2032-01-02T00:00:00Z");

    const created = await createBooking(
      {
        customerId,
        vehicleId: vehicle.id,
        pickupLocationId: locUtc,
        dropoffLocationId: locUtc,
        pickupAt,
        returnAt,
        driverDateOfBirth: ADULT_DOB,
        driverFullName: "Jane Driver",
        driverPhone: "+639171234567",
        driverEmail: "jane.driver@example.com",
        driverLicenceNumber: "N01-23-456789",
        driverLicenceCountry: "PH",
        driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
      },
      { now: new Date("2031-01-01T00:00:00Z") }
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    bookingIds.push(created.bookingId);

    const beforeAvailable = await isVehicleAvailable(vehicle.id, pickupAt, returnAt);
    expect(beforeAvailable).toBe(false);

    const cancelOutcome = await cancelBooking(created.bookingId, "test cleanup");
    expect(cancelOutcome.ok).toBe(true);

    const afterAvailable = await isVehicleAvailable(vehicle.id, pickupAt, returnAt);
    expect(afterAvailable).toBe(true);
  });
});
