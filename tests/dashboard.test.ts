import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient, type BookingStatus, type PaymentStatus } from "@prisma/client";
import {
  getDashboardSummary,
  prisma as dashboardPrisma,
} from "../lib/services/dashboard.service";
import { countsForViews, prisma as bookingQueryPrisma } from "../lib/services/booking-query.service";
import { deriveVehicleStatuses } from "../lib/services/fleet.service";
import { prisma as catalogPrisma } from "../lib/services/catalog.service";
import { authorize } from "../lib/auth/guard";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

let categoryId: string;
let modelId: string;
let customerId: string;
let locUtc: string;
let locKiritimati: string;

const vehicleIds: string[] = [];
const bookingIds: string[] = [];
let refCounter = 0;

function nextRef(): string {
  refCounter += 1;
  return `DASH-TEST-${Date.now()}-${refCounter}`;
}

async function createTestVehicle(locationId: string) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `DBT-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: locationId,
      currentLocationId: locationId,
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
  pickupAt: Date;
  returnAt: Date;
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  createdAt?: Date;
  checkedInAt?: Date;
  totalAmount?: bigint;
  amountPaid?: bigint;
  securityDeposit?: bigint;
}

async function createTestBooking(overrides: BookingOverrides) {
  const booking = await prisma.booking.create({
    data: {
      reference: nextRef(),
      customerId,
      vehicleId: overrides.vehicleId,
      pickupLocationId: overrides.pickupLocationId,
      dropoffLocationId: overrides.pickupLocationId,
      pickupAt: overrides.pickupAt,
      returnAt: overrides.returnAt,
      subtotalAmount: overrides.totalAmount ?? BigInt(100000),
      taxAmount: BigInt(0),
      securityDeposit: overrides.securityDeposit ?? BigInt(50000),
      rentalDays: 1,
      totalAmount: overrides.totalAmount ?? BigInt(100000),
      amountPaid: overrides.amountPaid ?? BigInt(0),
      status: overrides.status ?? "PENDING",
      paymentStatus: overrides.paymentStatus ?? "UNPAID",
      driverFullName: "Test Driver",
      driverPhone: "+639171234567",
      driverEmail: "driver@example.com",
      driverLicenceNumber: "N01-23-456789",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: new Date("2099-01-01T00:00:00Z"),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.checkedInAt ? { checkedInAt: overrides.checkedInAt } : {}),
    },
  });
  bookingIds.push(booking.id);
  return booking;
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_dashboard_category__" },
    update: {},
    create: { name: "__test_dashboard_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "DashTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const customer = await prisma.customer.create({
    data: { email: `dashboard-test-${Date.now()}@example.com`, name: "Dashboard Test Customer" },
  });
  customerId = customer.id;

  // Non-zero buffers: deriveVehicleStatuses checks block overlap against
  // expandWindow(now, now, buffers) — with zero buffers that's a
  // zero-width range, which Postgres tstzrange treats as empty and never
  // overlaps anything (see fleet.test.ts's identical setup for why).
  const locA = await prisma.location.create({
    data: { name: `__dbt_loc_utc__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 60, turnaroundMinutes: 60 },
  });
  locUtc = locA.id;

  const locB = await prisma.location.create({
    data: {
      name: `__dbt_loc_kiritimati__${Date.now()}`,
      timezone: "Pacific/Kiritimati",
      openingHours: {},
      prepMinutes: 60,
      turnaroundMinutes: 60,
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
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.$disconnect();
  await dashboardPrisma.$disconnect();
  await bookingQueryPrisma.$disconnect();
  await catalogPrisma.$disconnect();
});

// ==================== Action queues ====================

describe("getDashboardSummary: action queues", () => {
  it("1. a CONFIRMED booking with pickup today at the business timezone appears in pickupsToday", async () => {
    const now = new Date("2031-03-10T02:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-03-10T14:00:00Z"),
      returnAt: new Date("2031-03-11T14:00:00Z"),
      status: "CONFIRMED",
    });
    const after = await getDashboardSummary(now, prisma, false);
    expect(after.actionQueues.pickupsToday.count).toBe(before.actionQueues.pickupsToday.count + 1);
  });

  it("2. a booking whose pickup is today in UTC but NOT today at the business timezone (Pacific/Kiritimati) does not appear", async () => {
    const settings = await prisma.settings.findFirst({ select: { businessTimezone: true } });
    const original = settings?.businessTimezone;
    await prisma.settings.updateMany({ data: { businessTimezone: "Pacific/Kiritimati" } });
    try {
      // now: 2030-06-15T00:00:00Z -> Kiritimati (+14h) local day is also June 15.
      const now = new Date("2030-06-15T00:00:00Z");
      const vehicle = await createTestVehicle(locKiritimati);
      const before = await getDashboardSummary(now, prisma, false);
      // pickupAt: 2030-06-15T23:00:00Z -> UTC day June 15 ("today" in UTC), but
      // Kiritimati local (+14h) is June 16 -> NOT today at the business tz.
      await createTestBooking({
        vehicleId: vehicle.id,
        pickupLocationId: locKiritimati,
        pickupAt: new Date("2030-06-15T23:00:00Z"),
        returnAt: new Date("2030-06-17T00:00:00Z"),
        status: "CONFIRMED",
      });
      const after = await getDashboardSummary(now, prisma, false);
      expect(after.actionQueues.pickupsToday.count).toBe(before.actionQueues.pickupsToday.count);
    } finally {
      if (original !== undefined) await prisma.settings.updateMany({ data: { businessTimezone: original } });
    }
  });

  it("3. an ONGOING booking past grace appears in overdue and NOT in returnsToday", async () => {
    const now = new Date("2031-04-10T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-04-08T00:00:00Z"),
      // A day before `now`, not merely hours before: isReturningToday
      // compares calendar days, so a same-day-but-overdue return would
      // also read as "returning today" — this booking must be overdue on
      // a DIFFERENT calendar day to prove the two queues don't overlap.
      returnAt: new Date("2031-04-09T10:00:00Z"),
      status: "ONGOING",
    });
    const after = await getDashboardSummary(now, prisma, false);
    expect(after.actionQueues.overdue.count).toBe(before.actionQueues.overdue.count + 1);
    expect(after.actionQueues.returnsToday.count).toBe(before.actionQueues.returnsToday.count);
  });

  it("4. a PENDING booking older than 2h appears in pendingConfirmation", async () => {
    const now = new Date("2031-05-10T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-05-20T00:00:00Z"),
      returnAt: new Date("2031-05-21T00:00:00Z"),
      status: "PENDING",
      createdAt: new Date("2031-05-10T08:00:00Z"), // 4h old
    });
    const after = await getDashboardSummary(now, prisma, false);
    expect(after.actionQueues.pendingConfirmation.count).toBe(before.actionQueues.pendingConfirmation.count + 1);
  });

  it("5. a FAILED payment appears in paymentFailed", async () => {
    const now = new Date("2031-06-10T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-06-20T00:00:00Z"),
      returnAt: new Date("2031-06-21T00:00:00Z"),
      status: "CONFIRMED",
      paymentStatus: "FAILED",
    });
    const after = await getDashboardSummary(now, prisma, false);
    expect(after.actionQueues.paymentFailed.count).toBe(before.actionQueues.paymentFailed.count + 1);
  });

  it("6. a COMPLETED booking appears in no queue", async () => {
    const now = new Date("2031-07-10T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-07-01T00:00:00Z"),
      returnAt: new Date("2031-07-05T00:00:00Z"),
      status: "COMPLETED",
      paymentStatus: "PAID",
      checkedInAt: new Date("2031-07-05T00:00:00Z"),
    });
    const after = await getDashboardSummary(now, prisma, false);
    expect(after.actionQueues.overdue.count).toBe(before.actionQueues.overdue.count);
    expect(after.actionQueues.pickupsToday.count).toBe(before.actionQueues.pickupsToday.count);
    expect(after.actionQueues.returnsToday.count).toBe(before.actionQueues.returnsToday.count);
    expect(after.actionQueues.pendingConfirmation.count).toBe(before.actionQueues.pendingConfirmation.count);
    expect(after.actionQueues.paymentFailed.count).toBe(before.actionQueues.paymentFailed.count);
  });
});

// ==================== Fleet status ====================

describe("getDashboardSummary: fleet status", () => {
  it("7. counts by status sum to the number of active vehicles", async () => {
    const now = new Date("2031-01-01T00:00:00Z");
    const summary = await getDashboardSummary(now, prisma, false);
    const sum = Object.values(summary.fleetStatus.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(summary.fleetStatus.totalActive);
  });

  it("8. archived vehicles are excluded from every count", async () => {
    const now = new Date("2031-01-01T00:00:00Z");
    const before = await getDashboardSummary(now, prisma, false);
    const vehicle = await createTestVehicle(locUtc);
    const afterCreate = await getDashboardSummary(now, prisma, false);
    expect(afterCreate.fleetStatus.totalActive).toBe(before.fleetStatus.totalActive + 1);

    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { archivedAt: now } });
    const afterArchive = await getDashboardSummary(now, prisma, false);
    expect(afterArchive.fleetStatus.totalActive).toBe(before.fleetStatus.totalActive);
    expect(afterArchive.fleetStatus.counts.AVAILABLE).toBe(before.fleetStatus.counts.AVAILABLE);
  });

  it("9. a vehicle in maintenance counts as MAINTENANCE, not AVAILABLE", async () => {
    const now = new Date("2031-01-01T00:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, false);
    expect(before.fleetStatus.counts.AVAILABLE).toBeGreaterThanOrEqual(0);

    await prisma.$executeRawUnsafe(
      `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
       VALUES ($1::uuid, 'MAINTENANCE'::"BlockType", tstzrange($2::timestamptz, $3::timestamptz, '[)'), now())`,
      vehicle.id,
      "2030-12-31T00:00:00Z",
      "2031-01-02T00:00:00Z"
    );

    const after = await getDashboardSummary(now, prisma, false);
    expect(after.fleetStatus.counts.MAINTENANCE).toBe(before.fleetStatus.counts.MAINTENANCE + 1);
    expect(after.fleetStatus.totalActive).toBe(before.fleetStatus.totalActive);

    await prisma.vehicleBlock.deleteMany({ where: { vehicleId: vehicle.id } });
  });
});

// ==================== Money ====================

describe("getDashboardSummary: money", () => {
  it("10 & 11. revenue counts only COMPLETED bookings, and excludes the security deposit", async () => {
    const now = new Date("2031-02-15T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, true);

    // Not COMPLETED -> must not affect revenue.
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-02-01T00:00:00Z"),
      returnAt: new Date("2031-02-02T00:00:00Z"),
      status: "CONFIRMED",
      checkedInAt: now,
      totalAmount: BigInt(999999),
      securityDeposit: BigInt(500000),
    });
    const afterConfirmed = await getDashboardSummary(now, prisma, true);
    expect(afterConfirmed.money!.revenueToday).toBe(before.money!.revenueToday);

    // COMPLETED with a large security deposit -> only totalAmount counts.
    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-02-01T00:00:00Z"),
      returnAt: new Date("2031-02-02T00:00:00Z"),
      status: "COMPLETED",
      paymentStatus: "PAID",
      checkedInAt: now,
      totalAmount: BigInt(150000),
      securityDeposit: BigInt(500000),
    });
    const afterCompleted = await getDashboardSummary(now, prisma, true);
    expect(afterCompleted.money!.revenueToday).toBe(afterConfirmed.money!.revenueToday + BigInt(150000));
  });

  it("12. outstanding balance sums balanceDue across unpaid bookings", async () => {
    const now = new Date("2031-02-20T12:00:00Z");
    const vehicle = await createTestVehicle(locUtc);
    const before = await getDashboardSummary(now, prisma, true);

    await createTestBooking({
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      pickupAt: new Date("2031-02-25T00:00:00Z"),
      returnAt: new Date("2031-02-26T00:00:00Z"),
      status: "CONFIRMED",
      paymentStatus: "PARTIALLY_PAID",
      totalAmount: BigInt(200000),
      amountPaid: BigInt(80000),
    });

    const after = await getDashboardSummary(now, prisma, true);
    expect(after.money!.outstandingBalance).toBe(before.money!.outstandingBalance + BigInt(120000));
  });

  it("13. revenue periods are bounded at the business timezone, not UTC", async () => {
    const settings = await prisma.settings.findFirst({ select: { businessTimezone: true } });
    const original = settings?.businessTimezone;
    await prisma.settings.updateMany({ data: { businessTimezone: "Pacific/Kiritimati" } });
    try {
      // now: 2030-06-15T01:00:00Z -> Kiritimati (+14h) local day is June 15.
      const now = new Date("2030-06-15T01:00:00Z");
      const vehicle = await createTestVehicle(locKiritimati);
      const before = await getDashboardSummary(now, prisma, true);

      // checkedInAt: 2030-06-14T12:00:00Z -> UTC calendar day is June 14
      // ("yesterday"), but Kiritimati local (+14h) is June 15 ("today").
      await createTestBooking({
        vehicleId: vehicle.id,
        pickupLocationId: locKiritimati,
        pickupAt: new Date("2030-06-14T00:00:00Z"),
        returnAt: new Date("2030-06-14T12:00:00Z"),
        status: "COMPLETED",
        paymentStatus: "PAID",
        checkedInAt: new Date("2030-06-14T12:00:00Z"),
        totalAmount: BigInt(75000),
      });

      const after = await getDashboardSummary(now, prisma, true);
      expect(after.money!.revenueToday).toBe(before.money!.revenueToday + BigInt(75000));
    } finally {
      if (original !== undefined) await prisma.settings.updateMany({ data: { businessTimezone: original } });
    }
  });
});

// ==================== Consistency ====================

describe("getDashboardSummary: consistency with the primitives it reuses", () => {
  const now = new Date("2031-08-01T00:00:00Z");

  it("14. overdue equals the length of booking-query's overdue saved view for the same now", async () => {
    const [summary, counts] = await Promise.all([getDashboardSummary(now, prisma, false), countsForViews({}, now)]);
    expect(summary.actionQueues.overdue.count).toBe(counts.overdue);
  });

  it("15. pendingConfirmation equals the pending saved view", async () => {
    const [summary, counts] = await Promise.all([getDashboardSummary(now, prisma, false), countsForViews({}, now)]);
    expect(summary.actionQueues.pendingConfirmation.count).toBe(counts.pending);
  });

  it("16. fleet status counts match deriveVehicleStatuses over the same ids for the same now", async () => {
    const activeIds = (await prisma.vehicle.findMany({ where: { archivedAt: null }, select: { id: true } })).map((v) => v.id);
    const [summary, statusById] = await Promise.all([
      getDashboardSummary(now, prisma, false),
      deriveVehicleStatuses(activeIds, now),
    ]);
    const expectedCounts = { AVAILABLE: 0, RENTED: 0, RESERVED: 0, MAINTENANCE: 0, BLOCKED: 0 };
    for (const id of activeIds) {
      const status = statusById.get(id) ?? "AVAILABLE";
      expectedCounts[status] += 1;
    }
    expect(summary.fleetStatus.counts).toEqual(expectedCounts);
  });
});

// ==================== Query budget ====================

function spyOnDashboardQueries() {
  const spies = [
    vi.spyOn(dashboardPrisma.vehicle, "findMany"),
    vi.spyOn(dashboardPrisma.location, "findMany"),
    vi.spyOn(dashboardPrisma, "$queryRaw"),
    vi.spyOn(dashboardPrisma.booking, "findMany"),
    vi.spyOn(dashboardPrisma.booking, "groupBy"),
    vi.spyOn(dashboardPrisma.settings, "findFirst"),
    vi.spyOn(bookingQueryPrisma.booking, "findMany"),
    vi.spyOn(bookingQueryPrisma.settings, "findFirst"),
    vi.spyOn(catalogPrisma.location, "findMany"),
    vi.spyOn(catalogPrisma.settings, "findFirst"),
  ];
  return {
    count: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

describe("getDashboardSummary: query budget", () => {
  it("17. issues no more than 12 queries for a MANAGER (money included)", async () => {
    const now = new Date("2031-09-01T00:00:00Z");
    const counter = spyOnDashboardQueries();
    // No client override here: the spies target dashboard.service's own
    // exported `prisma`, which is only what runs when getDashboardSummary
    // uses its default `db` parameter.
    await getDashboardSummary(now, undefined, true);
    const count = counter.count();
    counter.restore();

    // Reported in the phase's final report: countsForViews (3: booking
    // findMany, catalog location findMany, settings findFirst for
    // billingGraceMinutes) + getBusinessTimezone (1) + active vehicle ids
    // (1) + deriveVehicleStatuses (3) + [all-bookings findMany + currency
    // settings findFirst] (2) + next-7-days findMany (1) + recent-activity
    // findMany (1) = 12.
    expect(count).toBeLessThanOrEqual(12);
  });

  it("issues fewer queries for STAFF (money excluded) than for a MANAGER", async () => {
    const now = new Date("2031-09-01T00:00:00Z");
    const counterStaff = spyOnDashboardQueries();
    await getDashboardSummary(now, undefined, false);
    const staffCount = counterStaff.count();
    counterStaff.restore();

    // STAFF path: countsForViews (3) + getBusinessTimezone (1) + active
    // vehicle ids (1) + deriveVehicleStatuses (3) + paymentStatus groupBy
    // (1) + next-7-days (1) + recent-activity (1) = 11.
    expect(staffCount).toBe(11);
  });
});

// ==================== Authorisation ====================

describe("getDashboardSummary: authorisation", () => {
  it("18. /admin requires STAFF: no session is denied", async () => {
    const outcome = await authorize(undefined, "STAFF");
    expect(outcome.ok).toBe(false);
  });

  it('18b. app/admin/page.tsx calls requireAuth("STAFF")', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/page.tsx"), "utf8");
    expect(source).toContain('requireAuth("STAFF")');
  });

  it("19. the money section is absent for STAFF (includeMoney=false), by not calling for it", async () => {
    const now = new Date("2031-09-02T00:00:00Z");
    const summary = await getDashboardSummary(now, prisma, false);
    expect(summary.money).toBeNull();
  });

  it("19b. app/admin/page.tsx gates includeMoney on roleSatisfies(user.role, \"MANAGER\")", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/page.tsx"), "utf8");
    expect(source).toContain('roleSatisfies(user.role, "MANAGER")');
    expect(source).toContain("getDashboardSummary(now, undefined, canSeeMoney)");
  });
});

// ==================== Links ====================

describe("getDashboardSummary: action queue hrefs", () => {
  it("20. each href, parsed, produces the filter set that returns exactly that queue's rows", async () => {
    const now = new Date("2031-09-05T00:00:00Z");
    const summary = await getDashboardSummary(now, prisma, false);
    const counts = await countsForViews({}, now);

    const cases: Array<{ href: string; expected: number }> = [
      { href: summary.actionQueues.overdue.href, expected: counts.overdue },
      { href: summary.actionQueues.pickupsToday.href, expected: counts.startingToday },
      { href: summary.actionQueues.returnsToday.href, expected: counts.returningToday },
      { href: summary.actionQueues.pendingConfirmation.href, expected: counts.pending },
    ];

    for (const { href, expected } of cases) {
      const params = new URLSearchParams(href.split("?")[1]);
      const view = params.get("view") as "overdue" | "startingToday" | "returningToday" | "pending";
      expect(counts[view]).toBe(expected);
    }

    const paymentFailedParams = new URLSearchParams(summary.actionQueues.paymentFailed.href.split("?")[1]);
    expect(paymentFailedParams.get("paymentStatus")).toBe("FAILED");
    const rawCount = await prisma.booking.count({ where: { paymentStatus: "FAILED" } });
    expect(summary.actionQueues.paymentFailed.count).toBe(rawCount);
  });
});
