import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient, type UserRole } from "@prisma/client";
import {
  findOrCreateCustomer,
  setCustomerFlag,
  clearCustomerFlag,
  updateStaffNotes as updateCustomerStaffNotes,
  isCustomerBlocked,
  prisma as customerPrisma,
} from "../lib/services/customer.service";
import {
  listCustomers,
  getCustomerDetail,
  prisma as customerQueryPrisma,
} from "../lib/services/customer-query.service";
import { selectVehicle, submitBooking } from "../lib/services/booking-flow.service";
import { prisma as quotePrisma } from "../lib/services/quote.service";
import { prisma as bookingPrisma } from "../lib/services/booking.service";
import { prisma as availabilityPrisma } from "../lib/services/availability.service";
import { prisma as searchPrisma } from "../lib/services/search.service";
import { prisma as catalogPrisma } from "../lib/services/catalog.service";
import { prisma as notificationPrisma } from "../lib/services/notification.service";
import { authorize, roleSatisfies } from "../lib/auth/guard";
import { hashPassword } from "../lib/auth/password";
import { createSession, prisma as sessionPrisma } from "../lib/auth/session";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const REF_NOW = new Date();
const FAR_FUTURE_LICENCE_EXPIRY = new Date("2099-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let locA: string;
let managerUserId: string;

const vehicleIds: string[] = [];
const customerEmails: string[] = [];
const customerIds: string[] = [];
const userIds: string[] = [];

function dobForAge(age: number, asOf: Date): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear() - age, asOf.getUTCMonth(), asOf.getUTCDate()));
}

async function createVehicle() {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `CUS-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: locA,
      currentLocationId: locA,
      dailyRate: BigInt(100000),
      securityDeposit: BigInt(50000),
      minRentalDays: 1,
      maxRentalDays: null,
      minDriverAge: 21,
      isBookableOnline: true,
    },
  });
  vehicleIds.push(vehicle.id);
  return vehicle;
}

async function createCustomer(overrides: { name?: string; phone?: string } = {}) {
  const email = `cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  customerEmails.push(email);
  const customer = await prisma.customer.create({
    data: { email, name: overrides.name ?? "Test Customer", phone: overrides.phone ?? null },
  });
  customerIds.push(customer.id);
  return customer;
}

// Bookings inserted directly (like tests/check-in-out.test.ts) — no
// vehicle_blocks row is created this way, so many bookings can share a
// vehicle/window here without tripping the exclusion constraint; that
// constraint is exercised elsewhere (vehicle-blocks-availability.test.ts).
async function createBookingRow(overrides: {
  customerId: string;
  vehicleId: string;
  status?: "PENDING" | "CONFIRMED" | "ONGOING" | "COMPLETED" | "CANCELLED";
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "REFUNDED" | "FAILED";
  pickupAt?: Date;
  returnAt?: Date;
  rentalDays?: number;
  totalAmount?: bigint;
  amountPaid?: bigint;
}) {
  const pickupAt = overrides.pickupAt ?? new Date("2031-01-01T00:00:00Z");
  const returnAt = overrides.returnAt ?? new Date("2031-01-02T00:00:00Z");
  const totalAmount = overrides.totalAmount ?? BigInt(112000);
  const booking = await prisma.booking.create({
    data: {
      reference: `CUS-${Math.random().toString(36).slice(2, 10)}`,
      customerId: overrides.customerId,
      vehicleId: overrides.vehicleId,
      pickupLocationId: locA,
      dropoffLocationId: locA,
      pickupAt,
      returnAt,
      rentalDays: overrides.rentalDays ?? 1,
      subtotalAmount: BigInt(100000),
      taxAmount: BigInt(12000),
      totalAmount,
      amountPaid: overrides.amountPaid ?? BigInt(0),
      securityDeposit: BigInt(50000),
      status: overrides.status ?? "COMPLETED",
      paymentStatus: overrides.paymentStatus ?? "UNPAID",
      driverFullName: "Row Driver",
      driverPhone: "+639170000001",
      driverEmail: "row.driver@example.com",
      driverLicenceNumber: "N01-23-000000",
      driverLicenceCountry: "PH",
      driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
    },
  });
  return booking;
}

function driverPayload(overrides: Record<string, unknown> = {}) {
  const email = `flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  customerEmails.push(email);
  return {
    driverFullName: "Flag Test Driver",
    driverEmail: email,
    driverPhone: "+639170000000",
    driverDateOfBirth: dobForAge(30, REF_NOW),
    driverLicenceNumber: "N01-23-999999",
    driverLicenceCountry: "PH",
    driverLicenceExpiry: FAR_FUTURE_LICENCE_EXPIRY,
    ...overrides,
  };
}

async function sessionFor(role: UserRole): Promise<string> {
  const passwordHash = await hashPassword("Correct-Horse-Battery-1!");
  const user = await prisma.user.create({
    data: {
      email: `customers-test-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      name: "Test Staff",
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
    where: { name: "__test_customers_category__" },
    update: {},
    create: { name: "__test_customers_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "CustomersTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const a = await prisma.location.create({
    data: { name: `__cust_loc_a__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locA = a.id;

  const passwordHash = await hashPassword("Correct-Horse-Battery-1!");
  const manager = await prisma.user.create({
    data: {
      email: `customers-test-flagger-${Date.now()}@example.com`,
      name: "Test Flagger",
      role: "MANAGER",
      isActive: true,
      passwordHash,
    },
  });
  userIds.push(manager.id);
  managerUserId = manager.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.bookingLineItem.deleteMany({ where: { booking: { vehicleId: { in: vehicleIds } } } });
  await prisma.booking.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.quoteLineItem.deleteMany({ where: { quote: { vehicleId: { in: vehicleIds } } } });
  await prisma.quote.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.customer.deleteMany({ where: { OR: [{ id: { in: customerIds } }, { email: { in: customerEmails } }] } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: locA } });
  await prisma.$disconnect();
  await customerPrisma.$disconnect();
  await customerQueryPrisma.$disconnect();
  await quotePrisma.$disconnect();
  await bookingPrisma.$disconnect();
  await availabilityPrisma.$disconnect();
  await searchPrisma.$disconnect();
  await catalogPrisma.$disconnect();
  await notificationPrisma.$disconnect();
  await sessionPrisma.$disconnect();
});

describe("derived stats", () => {
  it("1. a customer with three bookings reports totalBookings 3", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED" });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CONFIRMED" });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CANCELLED" });

    const detail = await getCustomerDetail(customer.id, REF_NOW);
    expect(detail?.totalBookings).toBe(3);
  });

  it("2. cancelled bookings are counted separately, not as completed", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED" });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CANCELLED" });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CANCELLED" });

    const detail = await getCustomerDetail(customer.id, REF_NOW);
    expect(detail?.completedBookings).toBe(1);
    expect(detail?.cancelledBookings).toBe(2);
  });

  it("3. lifetime revenue counts only COMPLETED bookings", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED", totalAmount: BigInt(50000) });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CONFIRMED", totalAmount: BigInt(999999) });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CANCELLED", totalAmount: BigInt(999999) });

    const detail = await getCustomerDetail(customer.id, REF_NOW);
    expect(detail?.lifetimeRevenue).toBe(BigInt(50000));
  });

  it("4. outstanding balance sums balanceDue across unpaid bookings", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED", totalAmount: BigInt(10000), amountPaid: BigInt(4000) });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "CONFIRMED", totalAmount: BigInt(20000), amountPaid: BigInt(0) });
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED", totalAmount: BigInt(5000), amountPaid: BigInt(5000) });

    const detail = await getCustomerDetail(customer.id, REF_NOW);
    // (10000-4000) + (20000-0) + (5000-5000) = 26000
    expect(detail?.outstandingBalance).toBe(BigInt(26000));
  });

  it("5. a customer with no bookings reports zeroes, not nulls", async () => {
    const customer = await createCustomer();
    const detail = await getCustomerDetail(customer.id, REF_NOW);
    expect(detail?.totalBookings).toBe(0);
    expect(detail?.completedBookings).toBe(0);
    expect(detail?.cancelledBookings).toBe(0);
    expect(detail?.lifetimeRevenue).toBe(BigInt(0));
    expect(detail?.outstandingBalance).toBe(BigInt(0));
    expect(detail?.averageRentalDays).toBe(0);
    expect(detail?.currentRental).toBeNull();
  });

  it("6. stats are computed against the passed-in now, not the system clock", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    const pickupAt = new Date("2031-06-01T00:00:00Z");
    const returnAt = new Date("2031-06-02T00:00:00Z");
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "ONGOING", pickupAt, returnAt });

    const beforeReturn = await getCustomerDetail(customer.id, new Date("2031-06-01T12:00:00Z"));
    const wellAfterReturn = await getCustomerDetail(customer.id, new Date("2032-01-01T00:00:00Z"));

    expect(beforeReturn?.currentRental?.isOverdue).toBe(false);
    expect(wellAfterReturn?.currentRental?.isOverdue).toBe(true);
  });
});

describe("flags", () => {
  it("7. setCustomerFlag with a reason persists flag, reason, actor and timestamp", async () => {
    const customer = await createCustomer();
    const token = await sessionFor("MANAGER");
    const outcome = await authorize(token, "MANAGER");
    if (!outcome.ok) throw new Error("expected authorized session");

    const now = new Date("2031-02-01T00:00:00Z");
    const result = await setCustomerFlag(customer.id, "VIP", "Frequent flyer, always pays on time", outcome.user.id, { now });
    expect(result.ok).toBe(true);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.flag).toBe("VIP");
    expect(row.flagReason).toBe("Frequent flyer, always pays on time");
    expect(row.flaggedById).toBe(outcome.user.id);
    expect(row.flaggedAt?.toISOString()).toBe(now.toISOString());
  });

  it("8. setCustomerFlag with a blank reason is rejected with FLAG_REASON_REQUIRED and writes nothing", async () => {
    const customer = await createCustomer();
    const result = await setCustomerFlag(customer.id, "BLACKLISTED", "   ", managerUserId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("FLAG_REASON_REQUIRED");

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.flag).toBeNull();
    expect(row.flagReason).toBeNull();
    expect(row.flaggedAt).toBeNull();
    expect(row.flaggedById).toBeNull();
  });

  it("9. clearCustomerFlag clears all four fields", async () => {
    const customer = await createCustomer();
    const token = await sessionFor("MANAGER");
    const outcome = await authorize(token, "MANAGER");
    if (!outcome.ok) throw new Error("expected authorized session");

    await setCustomerFlag(customer.id, "VIP", "Some reason", outcome.user.id);
    await clearCustomerFlag(customer.id, outcome.user.id);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.flag).toBeNull();
    expect(row.flagReason).toBeNull();
    expect(row.flaggedAt).toBeNull();
    expect(row.flaggedById).toBeNull();
  });

  it("10. setting a second flag replaces the first — a customer is never both VIP and BLACKLISTED", async () => {
    const customer = await createCustomer();
    const token = await sessionFor("MANAGER");
    const outcome = await authorize(token, "MANAGER");
    if (!outcome.ok) throw new Error("expected authorized session");

    await setCustomerFlag(customer.id, "VIP", "Initially a VIP", outcome.user.id);
    await setCustomerFlag(customer.id, "BLACKLISTED", "Chargeback dispute", outcome.user.id);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.flag).toBe("BLACKLISTED");
    expect(row.flag).not.toBe("VIP");
    expect(row.flagReason).toBe("Chargeback dispute");
  });
});

describe("blacklist enforcement", () => {
  it("11. submitBooking for a BLACKLISTED customer is rejected and writes ZERO booking rows", async () => {
    const customer = await createCustomer();
    await setCustomerFlag(customer.id, "BLACKLISTED", "Prior no-show and damage dispute", managerUserId);
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-01-01T00:00:00Z");
    const returnAt = new Date("2033-01-02T00:00:00Z");

    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: customer.email }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(false);
    if (submitOutcome.ok) throw new Error("expected rejection");
    expect(submitOutcome.reason).toBe("CUSTOMER_BLOCKED");
    expect(await prisma.booking.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

  it("12. the rejection leaves no new customer row and no quote converted — the whole transaction rolled back", async () => {
    const customer = await createCustomer();
    await setCustomerFlag(customer.id, "BLACKLISTED", "Repeated late returns", managerUserId);
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-02-01T00:00:00Z");
    const returnAt = new Date("2033-02-02T00:00:00Z");

    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const countBefore = await prisma.customer.count({ where: { email: customer.email } });

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: customer.email }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(false);

    const countAfter = await prisma.customer.count({ where: { email: customer.email } });
    expect(countAfter).toBe(countBefore);

    const quoteRow = await prisma.quote.findUniqueOrThrow({ where: { id: quoteOutcome.quoteId } });
    expect(quoteRow.customerId).toBeNull();

    const block = await prisma.vehicleBlock.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(block.blockType).toBe("HOLD");
  });

  it("13. a VIP customer books normally", async () => {
    const customer = await createCustomer();
    await setCustomerFlag(customer.id, "VIP", "Long-time renter", managerUserId);
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-03-01T00:00:00Z");
    const returnAt = new Date("2033-03-02T00:00:00Z");

    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: customer.email }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(true);
  });

  it("14. a REQUIRES_DEPOSIT customer books normally — it warns, it does not block", async () => {
    const customer = await createCustomer();
    await setCustomerFlag(customer.id, "REQUIRES_DEPOSIT", "New customer, no rental history yet", managerUserId);
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-04-01T00:00:00Z");
    const returnAt = new Date("2033-04-02T00:00:00Z");

    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: customer.email }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(true);

    expect(await isCustomerBlocked(customer.id)).toBe(false);
  });

  it("15. blacklisting AFTER a booking exists does not retroactively cancel it", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    const pickupAt = new Date("2033-05-01T00:00:00Z");
    const returnAt = new Date("2033-05-02T00:00:00Z");

    const quoteOutcome = await selectVehicle(
      { vehicleId: vehicle.id, pickupLocationId: locA, dropoffLocationId: locA, pickupAt, returnAt },
      REF_NOW
    );
    if (!quoteOutcome.ok) throw new Error("expected quote");

    const submitOutcome = await submitBooking(
      { quoteId: quoteOutcome.quoteId, ...driverPayload({ driverEmail: customer.email }) },
      REF_NOW
    );
    expect(submitOutcome.ok).toBe(true);
    if (!submitOutcome.ok) throw new Error("expected success");

    await setCustomerFlag(customer.id, "BLACKLISTED", "Post-hoc dispute", managerUserId);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: submitOutcome.bookingId } });
    expect(booking.status).not.toBe("CANCELLED");
  });
});

describe("search and filters", () => {
  it("16. search by email finds the customer, case-insensitively", async () => {
    const customer = await createCustomer();
    const { rows } = await listCustomers({ search: customer.email.toUpperCase() }, {}, REF_NOW);
    expect(rows.some((r) => r.id === customer.id)).toBe(true);
  });

  it("17. search by phone finds them", async () => {
    const phone = `+63917${Math.floor(1000000 + Math.random() * 8999999)}`;
    const customer = await createCustomer({ phone });
    const { rows } = await listCustomers({ search: phone }, {}, REF_NOW);
    expect(rows.some((r) => r.id === customer.id)).toBe(true);
  });

  it("18. \"has outstanding balance\" returns only those with a balance", async () => {
    const withBalance = await createCustomer();
    const withoutBalance = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: withBalance.id, vehicleId: vehicle.id, status: "COMPLETED", totalAmount: BigInt(10000), amountPaid: BigInt(0) });
    await createBookingRow({ customerId: withoutBalance.id, vehicleId: vehicle.id, status: "COMPLETED", totalAmount: BigInt(10000), amountPaid: BigInt(10000) });

    const { rows } = await listCustomers({ hasOutstandingBalance: true, search: withBalance.email }, {}, REF_NOW);
    expect(rows.some((r) => r.id === withBalance.id)).toBe(true);

    const { rows: rowsWithout } = await listCustomers({ hasOutstandingBalance: true, search: withoutBalance.email }, {}, REF_NOW);
    expect(rowsWithout.some((r) => r.id === withoutBalance.id)).toBe(false);
  });

  it("19. \"repeat customer\" returns only those with 2 or more completed", async () => {
    const repeat = await createCustomer();
    const once = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: repeat.id, vehicleId: vehicle.id, status: "COMPLETED" });
    await createBookingRow({ customerId: repeat.id, vehicleId: vehicle.id, status: "COMPLETED" });
    await createBookingRow({ customerId: once.id, vehicleId: vehicle.id, status: "COMPLETED" });

    const { rows } = await listCustomers({ repeatCustomer: true, search: repeat.email }, {}, REF_NOW);
    expect(rows.some((r) => r.id === repeat.id)).toBe(true);

    const { rows: rowsOnce } = await listCustomers({ repeatCustomer: true, search: once.email }, {}, REF_NOW);
    expect(rowsOnce.some((r) => r.id === once.id)).toBe(false);
  });

  it("20. pagination returns stable, non-overlapping pages", async () => {
    const marker = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createCustomer({ name: `${marker}-${i}` }))
    );

    const page1 = await listCustomers({ search: marker }, { limit: 2 }, REF_NOW);
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listCustomers({ search: marker }, { limit: 2, cursor: page1.nextCursor ?? undefined }, REF_NOW);
    expect(page2.rows).toHaveLength(2);

    const page3 = await listCustomers({ search: marker }, { limit: 2, cursor: page2.nextCursor ?? undefined }, REF_NOW);
    expect(page3.rows).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(allIds).size).toBe(5);
    expect(allIds.sort()).toEqual(created.map((c) => c.id).sort());
  });
});

describe("security", () => {
  it("21. listCustomers and getCustomerDetail never return driverLicenceNumber", async () => {
    const customer = await createCustomer();
    const vehicle = await createVehicle();
    await createBookingRow({ customerId: customer.id, vehicleId: vehicle.id, status: "COMPLETED" });

    const { rows } = await listCustomers({ search: customer.email }, {}, REF_NOW);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("driverLicenceNumber");

    const detail = await getCustomerDetail(customer.id, REF_NOW);
    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("driverLicenceNumber");
    for (const row of detail?.bookingHistory ?? []) {
      expect("driverLicenceNumber" in row).toBe(false);
    }
  });

  it("22. /admin/customers requires MANAGER — a STAFF session is denied", async () => {
    const staffToken = await sessionFor("STAFF");
    const managerToken = await sessionFor("MANAGER");

    expect((await authorize(staffToken, "MANAGER")).ok).toBe(false);
    expect((await authorize(managerToken, "MANAGER")).ok).toBe(true);

    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/customers/page.tsx"), "utf8");
    expect(source).toContain('requireAuth("MANAGER")');
    const detailSource = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/customers/[id]/page.tsx"), "utf8");
    expect(detailSource).toContain('requireAuth("MANAGER")');
  });

  it("23. the customer link on booking detail is absent for STAFF", () => {
    expect(roleSatisfies("STAFF", "MANAGER")).toBe(false);
    expect(roleSatisfies("MANAGER", "MANAGER")).toBe(true);

    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/bookings/[id]/page.tsx"), "utf8");
    expect(source).toContain("canViewCustomerProfile");
    expect(source).toMatch(/canViewCustomerProfile\s*=\s*roleSatisfies\(user\.role,\s*"MANAGER"\)/);
    expect(source).toMatch(/\{canViewCustomerProfile\s*&&/);
  });
});

describe("customer dedup reuse", () => {
  it("findOrCreateCustomer still dedupes by email for the flag-enforcement fixtures above", async () => {
    const email = `dedupe-${Date.now()}@example.com`;
    customerEmails.push(email);
    const first = await findOrCreateCustomer({ email, name: "Dedup Test" });
    const second = await findOrCreateCustomer({ email, name: "Dedup Test" });
    expect(first.id).toBe(second.id);
  });
});

describe("staff notes", () => {
  it("updateStaffNotes writes the notes field", async () => {
    const customer = await createCustomer();
    await updateCustomerStaffNotes(customer.id, "Paid cash, ID verified.");
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.staffNotes).toBe("Paid cash, ID verified.");
  });
});
