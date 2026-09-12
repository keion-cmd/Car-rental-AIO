import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { quote, type QuoteInput, type QuoteVehicleInput, type QuoteSettingsInput } from "../lib/pricing/quote";
import { rentalDays } from "../lib/rental-days";
import { applyBasisPoints } from "../lib/money";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const SETTINGS: QuoteSettingsInput = {
  currency: "PHP",
  taxRateBps: 1200,
  youngDriverMaxAge: 24,
  youngDriverSurchargePerDay: BigInt(40000),
  billingGraceMinutes: 0,
};

const VEHICLE: QuoteVehicleInput = {
  dailyRate: BigInt(180000),
  weeklyRate: BigInt(180000) * BigInt(6),
  monthlyRate: BigInt(180000) * BigInt(22),
  securityDeposit: BigInt(500000),
  minRentalDays: 1,
  maxRentalDays: null,
  minDriverAge: 21,
};

const NOW = new Date("2027-01-01T00:00:00Z");
const ADULT_DOB = new Date("1990-01-01T00:00:00Z");

function baseInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    vehicle: VEHICLE,
    pickupLocationId: "loc-a",
    returnLocationId: "loc-a",
    pickupAt: new Date("2027-02-01T00:00:00Z"),
    returnAt: new Date("2027-02-02T00:00:00Z"),
    driverDateOfBirth: ADULT_DOB,
    now: NOW,
    settings: SETTINGS,
    locationPair: null,
    ...overrides,
  };
}

let seededVehicles: Array<{
  dailyRate: bigint;
  weeklyRate: bigint | null;
  monthlyRate: bigint | null;
  securityDeposit: bigint;
  minRentalDays: number;
  maxRentalDays: number | null;
  minDriverAge: number;
}> = [];

let lapuLapuId: string;
let cebuAirportId: string;
let disallowedPairFee: bigint;

beforeAll(async () => {
  const vehicles = await prisma.vehicle.findMany({ where: { dailyRate: { gt: BigInt(0) } } });
  seededVehicles = vehicles.map((v) => ({
    dailyRate: v.dailyRate,
    weeklyRate: v.weeklyRate,
    monthlyRate: v.monthlyRate,
    securityDeposit: v.securityDeposit,
    minRentalDays: v.minRentalDays,
    maxRentalDays: v.maxRentalDays,
    minDriverAge: v.minDriverAge,
  }));

  const lapuLapu = await prisma.location.findFirst({ where: { name: "Lapu-Lapu Branch" } });
  const cebuAirport = await prisma.location.findFirst({ where: { name: "Cebu Airport" } });
  if (!lapuLapu || !cebuAirport) {
    throw new Error("seed locations missing: Lapu-Lapu Branch / Cebu Airport");
  }
  lapuLapuId = lapuLapu.id;
  cebuAirportId = cebuAirport.id;

  const pair = await prisma.locationPair.findUnique({
    where: { fromLocationId_toLocationId: { fromLocationId: lapuLapuId, toLocationId: cebuAirportId } },
  });
  if (!pair || pair.isAllowed) {
    throw new Error("expected seeded disallowed pair Lapu-Lapu Branch -> Cebu Airport");
  }
  disallowedPairFee = pair.feeAmount;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("rentalDays — duration", () => {
  it("1. exactly 24h -> 1 day", () => {
    const result = rentalDays(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-02T00:00:00Z"), 0);
    expect(result).toEqual({ ok: true, days: 1 });
  });

  it("2. 25h -> 2 days", () => {
    const result = rentalDays(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-02T01:00:00Z"), 0);
    expect(result).toEqual({ ok: true, days: 2 });
  });

  it("3. 23h -> 1 day", () => {
    const result = rentalDays(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-01T23:00:00Z"), 0);
    expect(result).toEqual({ ok: true, days: 1 });
  });

  it("4. 24h + 30min with grace 59 -> 1 day (grace absorbs it)", () => {
    const result = rentalDays(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-02T00:30:00Z"), 59);
    expect(result).toEqual({ ok: true, days: 1 });
  });

  it("5. 24h + 90min with grace 59 -> 2 days (grace exceeded)", () => {
    const result = rentalDays(new Date("2027-01-01T00:00:00Z"), new Date("2027-01-02T01:30:00Z"), 59);
    expect(result).toEqual({ ok: true, days: 2 });
  });

  it("6. returnAt before pickupAt -> INVALID_DATE_RANGE", () => {
    const result = rentalDays(new Date("2027-01-02T00:00:00Z"), new Date("2027-01-01T00:00:00Z"), 0);
    expect(result).toEqual({ ok: false, reason: "INVALID_DATE_RANGE" });
  });
});

describe("quote — zero-rate guard", () => {
  it("7. dailyRate = 0 -> VEHICLE_NOT_PRICED, no total returned", () => {
    const result = quote(baseInput({ vehicle: { ...VEHICLE, dailyRate: BigInt(0) } }));
    expect(result).toEqual({ ok: false, reason: "VEHICLE_NOT_PRICED" });
  });

  it("8. dailyRate negative -> VEHICLE_NOT_PRICED", () => {
    const result = quote(baseInput({ vehicle: { ...VEHICLE, dailyRate: BigInt(-100) } }));
    expect(result).toEqual({ ok: false, reason: "VEHICLE_NOT_PRICED" });
  });

  it("9. weeklyRate = 0 on a 10-day rental -> falls back to daily, not zero", () => {
    const result = quote(
      baseInput({
        vehicle: { ...VEHICLE, weeklyRate: BigInt(0) },
        pickupAt: new Date("2027-02-01T00:00:00Z"),
        returnAt: new Date("2027-02-11T00:00:00Z"),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
    expect(baseLine.unitAmount).toBe(VEHICLE.dailyRate);
    expect(baseLine.totalAmount).toBe(VEHICLE.dailyRate * BigInt(10));
    expect(baseLine.totalAmount > BigInt(0)).toBe(true);
  });
});

describe("quote — tier selection", () => {
  it("10. 3 days uses daily", () => {
    const result = quote(
      baseInput({ pickupAt: new Date("2027-02-01T00:00:00Z"), returnAt: new Date("2027-02-04T00:00:00Z") })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
    expect(baseLine.unitAmount).toBe(BigInt(180000));
    expect(baseLine.totalAmount).toBe(BigInt(180000) * BigInt(3));
  });

  it("11. 8 days uses weekly", () => {
    const result = quote(
      baseInput({ pickupAt: new Date("2027-02-01T00:00:00Z"), returnAt: new Date("2027-02-09T00:00:00Z") })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
    // weeklyRate 1,080,000 / 7 rounds to 154286 per day
    expect(baseLine.unitAmount).toBe(BigInt(154286));
    expect(baseLine.totalAmount).toBe(BigInt(154286) * BigInt(8));
    expect(baseLine.totalAmount < BigInt(180000) * BigInt(8)).toBe(true);
  });

  it("12. 30 days uses monthly", () => {
    const result = quote(
      baseInput({ pickupAt: new Date("2027-02-01T00:00:00Z"), returnAt: new Date("2027-03-03T00:00:00Z") })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
    // monthlyRate 3,960,000 / 30 = 132000 per day exactly
    expect(baseLine.unitAmount).toBe(BigInt(132000));
    expect(baseLine.totalAmount).toBe(BigInt(132000) * BigInt(30));
  });

  it("13. CLAMP: every seeded vehicle's 7-day total <= 7x its daily rate", () => {
    expect(seededVehicles.length).toBeGreaterThan(0);
    let asserted = 0;
    for (const vehicle of seededVehicles) {
      const result = quote(
        baseInput({
          vehicle,
          pickupAt: new Date("2027-02-01T00:00:00Z"),
          returnAt: new Date("2027-02-08T00:00:00Z"),
        })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
      expect(baseLine.totalAmount <= vehicle.dailyRate * BigInt(7)).toBe(true);
      asserted += 1;
    }
    console.log(`clamp test 13 asserted ${asserted} seeded vehicles`);
    expect(asserted).toBe(seededVehicles.length);
  });

  it("14. CLAMP: every seeded vehicle's 28-day total <= 28x its daily rate", () => {
    let asserted = 0;
    for (const vehicle of seededVehicles) {
      const result = quote(
        baseInput({
          vehicle: { ...vehicle, maxRentalDays: null },
          pickupAt: new Date("2027-02-01T00:00:00Z"),
          returnAt: new Date("2027-03-01T00:00:00Z"),
        })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const baseLine = result.lineItems.find((l) => l.type === "BASE_RATE")!;
      expect(baseLine.totalAmount <= vehicle.dailyRate * BigInt(28)).toBe(true);
      asserted += 1;
    }
    console.log(`clamp test 14 asserted ${asserted} seeded vehicles`);
    expect(asserted).toBe(seededVehicles.length);
  });
});

describe("quote — money integrity", () => {
  function fullInput() {
    return baseInput({
      pickupLocationId: "loc-a",
      returnLocationId: "loc-b",
      locationPair: { isAllowed: true, feeAmount: BigInt(30000) },
      driverDateOfBirth: new Date("2003-01-01T00:00:00Z"), // age 24 at NOW -> surcharge
      pickupAt: new Date("2027-02-01T00:00:00Z"),
      returnAt: new Date("2027-02-06T00:00:00Z"), // 5 days
    });
  }

  it("15. every amount in the result is BigInt", () => {
    const result = quote(fullInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(typeof result.subtotalAmount).toBe("bigint");
    expect(typeof result.taxAmount).toBe("bigint");
    expect(typeof result.totalAmount).toBe("bigint");
    expect(typeof result.securityDeposit).toBe("bigint");
    for (const line of result.lineItems) {
      expect(typeof line.unitAmount).toBe("bigint");
      expect(typeof line.totalAmount).toBe("bigint");
    }
  });

  it("16. tax via basis points yields an exact integer, no fractional residue", () => {
    const result = quote(fullInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const taxableTotal = result.lineItems.filter((l) => l.isTaxable).reduce((sum, l) => sum + l.totalAmount, BigInt(0));
    expect(result.taxAmount).toBe(applyBasisPoints(taxableTotal, SETTINGS.taxRateBps));
  });

  it("17. sum of lineItems.totalAmount equals subtotalAmount exactly", () => {
    const result = quote(fullInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sum = result.lineItems.reduce((acc, l) => acc + l.totalAmount, BigInt(0));
    expect(sum).toBe(result.subtotalAmount);
  });

  it("18. subtotalAmount + taxAmount equals totalAmount exactly", () => {
    const result = quote(fullInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.subtotalAmount + result.taxAmount).toBe(result.totalAmount);
  });

  it("19. securityDeposit is NOT included in totalAmount", () => {
    const result = quote(fullInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.securityDeposit).toBe(VEHICLE.securityDeposit);
    expect(result.totalAmount).toBe(result.subtotalAmount + result.taxAmount);
    expect(result.totalAmount).not.toBe(result.totalAmount + result.securityDeposit);
  });
});

describe("quote — one-way", () => {
  it("20. same pickup and return location -> no one-way fee line", () => {
    const result = quote(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lineItems.find((l) => l.type === "FEE")).toBeUndefined();
  });

  it("21. different locations, allowed pair -> fee line present, matches feeAmount", () => {
    const result = quote(
      baseInput({
        pickupLocationId: "loc-a",
        returnLocationId: "loc-b",
        locationPair: { isAllowed: true, feeAmount: BigInt(30000) },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const feeLine = result.lineItems.find((l) => l.type === "FEE");
    expect(feeLine).toBeDefined();
    expect(feeLine!.totalAmount).toBe(BigInt(30000));
  });

  it("22. seeded disallowed pair (Lapu-Lapu Branch -> Cebu Airport) -> ONE_WAY_NOT_ALLOWED", () => {
    const result = quote(
      baseInput({
        pickupLocationId: lapuLapuId,
        returnLocationId: cebuAirportId,
        locationPair: { isAllowed: false, feeAmount: disallowedPairFee },
      })
    );
    expect(result).toEqual({ ok: false, reason: "ONE_WAY_NOT_ALLOWED" });
  });
});

describe("quote — young driver", () => {
  it("23. driver above youngDriverMaxAge -> no surcharge line", () => {
    const result = quote(baseInput({ driverDateOfBirth: new Date("2002-01-01T00:00:00Z") })); // age 25 at NOW
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lineItems.find((l) => l.type === "SURCHARGE")).toBeUndefined();
  });

  it("24. driver at exactly youngDriverMaxAge -> surcharge applies", () => {
    const result = quote(baseInput({ driverDateOfBirth: new Date("2003-01-01T00:00:00Z") })); // age 24 at NOW
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lineItems.find((l) => l.type === "SURCHARGE")).toBeDefined();
  });

  it("25. surcharge is per day — 5-day rental charges 5x", () => {
    const result = quote(
      baseInput({
        driverDateOfBirth: new Date("2003-01-01T00:00:00Z"),
        pickupAt: new Date("2027-02-01T00:00:00Z"),
        returnAt: new Date("2027-02-06T00:00:00Z"),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const surcharge = result.lineItems.find((l) => l.type === "SURCHARGE")!;
    expect(surcharge.quantity).toBe(5);
    expect(surcharge.totalAmount).toBe(SETTINGS.youngDriverSurchargePerDay * BigInt(5));
  });

  it("26. age computed from passed-in now, not system clock — differs either side of a birthday", () => {
    const dob = new Date("2001-06-15T00:00:00Z");
    const beforeBirthday = quote(baseInput({ driverDateOfBirth: dob, now: new Date("2026-06-14T00:00:00Z") }));
    const afterBirthday = quote(baseInput({ driverDateOfBirth: dob, now: new Date("2026-06-16T00:00:00Z") }));
    expect(beforeBirthday.ok).toBe(true);
    expect(afterBirthday.ok).toBe(true);
    if (!beforeBirthday.ok || !afterBirthday.ok) throw new Error("unreachable");
    expect(beforeBirthday.lineItems.find((l) => l.type === "SURCHARGE")).toBeDefined(); // age 24
    expect(afterBirthday.lineItems.find((l) => l.type === "SURCHARGE")).toBeUndefined(); // age 25
    expect(beforeBirthday).not.toEqual(afterBirthday);
  });

  it("27. driver below Vehicle.minDriverAge -> DRIVER_UNDER_AGE", () => {
    const result = quote(baseInput({ driverDateOfBirth: new Date("2007-01-01T00:00:00Z") })); // age 20, minDriverAge 21
    expect(result).toEqual({ ok: false, reason: "DRIVER_UNDER_AGE" });
  });
});

describe("quote — rental day limits", () => {
  it("28. below minRentalDays -> BELOW_MIN_RENTAL_DAYS", () => {
    const result = quote(
      baseInput({
        vehicle: { ...VEHICLE, minRentalDays: 3 },
        pickupAt: new Date("2027-02-01T00:00:00Z"),
        returnAt: new Date("2027-02-03T00:00:00Z"), // 2 days
      })
    );
    expect(result).toEqual({ ok: false, reason: "BELOW_MIN_RENTAL_DAYS" });
  });

  it("29. above maxRentalDays where set -> ABOVE_MAX_RENTAL_DAYS", () => {
    const result = quote(
      baseInput({
        vehicle: { ...VEHICLE, maxRentalDays: 10 },
        pickupAt: new Date("2027-02-01T00:00:00Z"),
        returnAt: new Date("2027-02-12T00:00:00Z"), // 11 days
      })
    );
    expect(result).toEqual({ ok: false, reason: "ABOVE_MAX_RENTAL_DAYS" });
  });
});

describe("quote — purity", () => {
  it("30. quote() twice with identical inputs -> deeply equal results", () => {
    const input1 = baseInput();
    const input2 = structuredClone(baseInput());
    const result1 = quote(input1);
    const result2 = quote(input2);
    expect(result1).toEqual(result2);
  });

  it("31. quote() performs no database write — row counts unchanged before and after", async () => {
    const before = await prisma.vehicle.count();
    for (let i = 0; i < 5; i++) {
      quote(baseInput());
    }
    const after = await prisma.vehicle.count();
    expect(after).toBe(before);
  });
});
