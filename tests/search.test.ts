import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { runVehicleSearch, parseSearchParams, type RawSearchParams } from "../lib/services/search.service";
import { zonedTimeToUtc } from "../lib/timezone";
import { priceRequest } from "../lib/services/quote.service";
import { listBrowsableVehiclesByCategory } from "../lib/services/catalog.service";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();
const ADULT_DOB = new Date("1990-01-01T00:00:00Z");

let categoryId: string;
let modelId: string;
let locUtc: string; // prep=0, turnaround=0, timezone UTC
let locOther: string; // separate pickup location
let locManila: string; // timezone Asia/Manila, for the tz-conversion test

const vehicleIds: string[] = [];
const locationIds: string[] = [];

async function createVehicle(overrides: {
  currentLocationId: string;
  dailyRate?: bigint;
  isBookableOnline?: boolean;
  archivedAt?: Date | null;
}) {
  const vehicle = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `SRCH-${Math.random().toString(36).slice(2, 10)}`,
      homeLocationId: overrides.currentLocationId,
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

async function insertRawBlock(vehicleId: string, start: string, end: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
     VALUES ($1::uuid, 'BOOKING'::"BlockType", tstzrange($2::timestamptz, $3::timestamptz, '[)'), now())`,
    vehicleId,
    start,
    end
  );
}

function params(overrides: Partial<RawSearchParams> = {}): RawSearchParams {
  return {
    pickupLocationId: locUtc,
    pickupDate: "2031-08-01",
    pickupTime: "09:00",
    returnDate: "2031-08-02",
    returnTime: "09:00",
    ...overrides,
  };
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_search_category__" },
    update: {},
    create: { name: "__test_search_category__" },
  });
  categoryId = category.id;

  const model = await prisma.vehicleModel.create({
    data: { categoryId, make: "SearchTest", model: "Unit", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  });
  modelId = model.id;

  const a = await prisma.location.create({
    data: { name: `__srch_loc_utc__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locUtc = a.id;

  const b = await prisma.location.create({
    data: { name: `__srch_loc_other__${Date.now()}`, timezone: "UTC", openingHours: {}, prepMinutes: 0, turnaroundMinutes: 0 },
  });
  locOther = b.id;

  const c = await prisma.location.create({
    data: {
      name: `__srch_loc_manila__${Date.now()}`,
      timezone: "Asia/Manila",
      openingHours: {},
      prepMinutes: 0,
      turnaroundMinutes: 0,
    },
  });
  locManila = c.id;

  locationIds.push(locUtc, locOther, locManila);
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
  await prisma.vehicleModel.deleteMany({ where: { id: modelId } });
  await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
  await prisma.$disconnect();
});

describe("search param handling", () => {
  it("1. valid query params parse to the correct service inputs", () => {
    const result = parseSearchParams(params({ dropoffLocationId: locOther }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pickupLocationId).toBe(locUtc);
      expect(result.data.dropoffLocationId).toBe(locOther);
      expect(result.data.pickupDate).toBe("2031-08-01");
      expect(result.data.pickupTime).toBe("09:00");
    }
  });

  it("2. missing required params produce a structured validation error, not a throw", () => {
    expect(() => parseSearchParams({})).not.toThrow();
    const result = parseSearchParams({});
    expect(result.success).toBe(false);
  });

  it("3. returnAt before pickupAt is rejected before any service call", () => {
    const result = parseSearchParams(
      params({ pickupDate: "2031-08-10", returnDate: "2031-08-09" })
    );
    expect(result.success).toBe(false);
  });

  it("4. a date/time in the pickup location's timezone converts to the correct UTC instant", async () => {
    // Asia/Manila is UTC+8 with no DST: 09:00 local is 01:00Z.
    const expectedUtc = zonedTimeToUtc("2031-08-01", "09:00", "Asia/Manila");
    expect(expectedUtc.toISOString()).toBe("2031-08-01T01:00:00.000Z");

    const outcome = await runVehicleSearch(params({ pickupLocationId: locManila, returnDate: "2031-08-02" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.criteria.pickupAt.toISOString()).toBe("2031-08-01T01:00:00.000Z");
    }
  });
});

describe("result integrity", () => {
  it("5. a vehicle blocked for the requested window does not appear", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc });
    await insertRawBlock(vehicle.id, "2031-09-01T00:00:00Z", "2031-09-02T00:00:00Z");
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-01", returnDate: "2031-09-02" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.vehicles.map((v) => v.id)).not.toContain(vehicle.id);
    }
  });

  it("6. a vehicle at a different location does not appear", async () => {
    const vehicle = await createVehicle({ currentLocationId: locOther });
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-03", returnDate: "2031-09-04" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.vehicles.map((v) => v.id)).not.toContain(vehicle.id);
    }
  });

  it("7. a vehicle with dailyRate = 0 does not appear", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(0) });
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-05", returnDate: "2031-09-06" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.vehicles.map((v) => v.id)).not.toContain(vehicle.id);
    }
  });

  it("8. each returned result carries a total that equals the quote engine result for the same inputs", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(150000) });
    const pickupAt = new Date("2031-09-10T09:00:00Z");
    const returnAt = new Date("2031-09-11T09:00:00Z");
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-10", returnDate: "2031-09-11" })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const found = outcome.vehicles.find((v) => v.id === vehicle.id);
    expect(found).toBeDefined();

    const expected = await priceRequest(prisma, {
      vehicleId: vehicle.id,
      pickupLocationId: locUtc,
      returnLocationId: locUtc,
      pickupAt,
      returnAt,
      driverDateOfBirth: ADULT_DOB,
      now: new Date(),
    });
    expect(expected.ok).toBe(true);
    if (expected.ok && found) {
      expect(found.totalAmount).toBe(expected.totalAmount);
    }
  });

  it("9. the total shown is for the whole period, not one day", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(100000) });

    const oneDay = await runVehicleSearch(
      params({ pickupDate: "2031-09-15", returnDate: "2031-09-16" })
    );
    const fiveDay = await runVehicleSearch(
      params({ pickupDate: "2031-09-20", returnDate: "2031-09-25" })
    );
    expect(oneDay.ok).toBe(true);
    expect(fiveDay.ok).toBe(true);
    if (!oneDay.ok || !fiveDay.ok) return;

    const one = oneDay.vehicles.find((v) => v.id === vehicle.id)!;
    const five = fiveDay.vehicles.find((v) => v.id === vehicle.id)!;
    expect(one).toBeDefined();
    expect(five).toBeDefined();

    const ratio = Number(five.totalAmount) / Number(one.totalAmount);
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(5.5);
  });

  it("10. an archived vehicle never appears", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, archivedAt: new Date() });
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-26", returnDate: "2031-09-27" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.vehicles.map((v) => v.id)).not.toContain(vehicle.id);
    }
  });

  it("11. a vehicle with isBookableOnline = false never appears", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, isBookableOnline: false });
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-09-28", returnDate: "2031-09-29" })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.vehicles.map((v) => v.id)).not.toContain(vehicle.id);
    }
  });
});

describe("fleet browse", () => {
  it("12. /vehicles data excludes archived, non-bookable and zero-rate vehicles", async () => {
    const good = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(120000) });
    const archived = await createVehicle({ currentLocationId: locUtc, archivedAt: new Date() });
    const offline = await createVehicle({ currentLocationId: locUtc, isBookableOnline: false });
    const zeroRate = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(0) });

    const categories = await listBrowsableVehiclesByCategory();
    const ids = categories.flatMap((c) => c.vehicles.map((v) => v.id));

    expect(ids).toContain(good.id);
    expect(ids).not.toContain(archived.id);
    expect(ids).not.toContain(offline.id);
    expect(ids).not.toContain(zeroRate.id);
  });

  it("13. a category with no bookable vehicles is omitted from the grouping", async () => {
    const emptyCategory = await prisma.vehicleCategory.upsert({
      where: { name: "__test_search_empty_category__" },
      update: {},
      create: { name: "__test_search_empty_category__" },
    });
    try {
      const categories = await listBrowsableVehiclesByCategory();
      expect(categories.map((c) => c.id)).not.toContain(emptyCategory.id);
    } finally {
      await prisma.vehicleCategory.delete({ where: { id: emptyCategory.id } });
    }
  });
});

describe("money", () => {
  it("14. no value passed to the view layer is a non-integer Number where money is concerned", async () => {
    const vehicle = await createVehicle({ currentLocationId: locUtc, dailyRate: BigInt(175050) });
    const outcome = await runVehicleSearch(
      params({ pickupDate: "2031-10-01", returnDate: "2031-10-02" })
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const found = outcome.vehicles.find((v) => v.id === vehicle.id);
    expect(found).toBeDefined();
    if (!found) return;

    expect(typeof found.dailyRate).toBe("bigint");
    expect(typeof found.totalAmount).toBe("bigint");

    const categories = await listBrowsableVehiclesByCategory();
    const browsed = categories.flatMap((c) => c.vehicles).find((v) => v.id === vehicle.id);
    expect(browsed).toBeDefined();
    expect(typeof browsed?.dailyRate).toBe("bigint");
  });
});
