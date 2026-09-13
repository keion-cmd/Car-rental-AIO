import { PrismaClient } from "@prisma/client";

// Plain read-only catalog access (locations, browsable/featured vehicles) —
// no availability windows, no pricing computation. That logic stays in
// availability.service.ts / quote.service.ts respectively.

export const prisma = new PrismaClient();

export interface CatalogLocation {
  id: string;
  name: string;
  timezone: string;
  isAirport: boolean;
  supportsPickup: boolean;
  supportsDropoff: boolean;
}

export async function listLocations(): Promise<CatalogLocation[]> {
  return prisma.location.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      timezone: true,
      isAirport: true,
      supportsPickup: true,
      supportsDropoff: true,
    },
  });
}

export async function getCurrency(): Promise<string> {
  const settings = await prisma.settings.findFirst({ select: { currency: true } });
  return settings?.currency ?? "PHP";
}

export async function getLocationById(id: string): Promise<CatalogLocation | null> {
  return prisma.location.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      timezone: true,
      isAirport: true,
      supportsPickup: true,
      supportsDropoff: true,
    },
  });
}

export interface CatalogVehicle {
  id: string;
  dailyRate: bigint;
  make: string;
  model: string;
  seats: number;
  transmission: "MANUAL" | "AUTOMATIC";
  fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
  categoryId: string;
  categoryName: string;
  imageUrl: string | null;
}

// Shared bookable/priced filter for anything showing a vehicle without a
// date search: excludes archived, offline, and zero-rate (unpriced) units.
const BOOKABLE_PRICED_WHERE = {
  archivedAt: null,
  isBookableOnline: true,
  dailyRate: { gt: BigInt(0) },
} as const;

function toCatalogVehicle(v: {
  id: string;
  dailyRate: bigint;
  model: {
    make: string;
    model: string;
    seats: number;
    transmission: "MANUAL" | "AUTOMATIC";
    fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC";
    category: { id: string; name: string };
  };
  images: Array<{ url: string }>;
}): CatalogVehicle {
  return {
    id: v.id,
    dailyRate: v.dailyRate,
    make: v.model.make,
    model: v.model.model,
    seats: v.model.seats,
    transmission: v.model.transmission,
    fuelType: v.model.fuelType,
    categoryId: v.model.category.id,
    categoryName: v.model.category.name,
    imageUrl: v.images[0]?.url ?? null,
  };
}

const CATALOG_VEHICLE_SELECT = {
  id: true,
  dailyRate: true,
  model: {
    select: {
      make: true,
      model: true,
      seats: true,
      transmission: true,
      fuelType: true,
      category: { select: { id: true, name: true } },
    },
  },
  images: { select: { url: true }, orderBy: { sortOrder: "asc" as const }, take: 1 },
};

export interface RentalRequirements {
  minDriverAgeAcrossFleet: number | null;
  youngDriverMaxAge: number;
  youngDriverSurchargePerDay: bigint;
  securityDepositMin: bigint | null;
  securityDepositMax: bigint | null;
  billingGraceMinutes: number;
  currency: string;
}

// Sourced live from Settings and Vehicle so this never drifts from what the
// booking flow actually enforces. Only bookable/priced vehicles count toward
// the deposit range and fleet-wide minimum age — archived/offline/unpriced
// units aren't rentable, so quoting their values would mislead a reader.
export async function getRentalRequirements(): Promise<RentalRequirements> {
  const [settings, ageAgg, depositAgg] = await Promise.all([
    prisma.settings.findFirst({
      select: { youngDriverMaxAge: true, youngDriverSurchargePerDay: true, billingGraceMinutes: true, currency: true },
    }),
    prisma.vehicle.aggregate({ where: BOOKABLE_PRICED_WHERE, _min: { minDriverAge: true } }),
    prisma.vehicle.aggregate({ where: BOOKABLE_PRICED_WHERE, _min: { securityDeposit: true }, _max: { securityDeposit: true } }),
  ]);

  return {
    minDriverAgeAcrossFleet: ageAgg._min.minDriverAge,
    youngDriverMaxAge: settings?.youngDriverMaxAge ?? 24,
    youngDriverSurchargePerDay: settings?.youngDriverSurchargePerDay ?? BigInt(0),
    securityDepositMin: depositAgg._min.securityDeposit,
    securityDepositMax: depositAgg._max.securityDeposit,
    billingGraceMinutes: settings?.billingGraceMinutes ?? 59,
    currency: settings?.currency ?? "PHP",
  };
}

export async function listFeaturedVehicles(limit: number): Promise<CatalogVehicle[]> {
  const rows = await prisma.vehicle.findMany({
    where: BOOKABLE_PRICED_WHERE,
    orderBy: { dailyRate: "desc" },
    take: limit,
    select: CATALOG_VEHICLE_SELECT,
  });
  return rows.map(toCatalogVehicle);
}

export interface CatalogCategory {
  id: string;
  name: string;
  vehicles: CatalogVehicle[];
}

// Groups by category, omitting any category with zero bookable, priced
// vehicles — this naturally excludes orphan seed categories (e.g.
// __test_category__) without special-casing their name.
export async function listBrowsableVehiclesByCategory(): Promise<CatalogCategory[]> {
  const rows = await prisma.vehicle.findMany({
    where: BOOKABLE_PRICED_WHERE,
    orderBy: [{ model: { category: { name: "asc" } } }, { dailyRate: "asc" }],
    select: CATALOG_VEHICLE_SELECT,
  });

  const byCategory = new Map<string, CatalogCategory>();
  for (const row of rows) {
    const vehicle = toCatalogVehicle(row);
    const existing = byCategory.get(vehicle.categoryId);
    if (existing) {
      existing.vehicles.push(vehicle);
    } else {
      byCategory.set(vehicle.categoryId, {
        id: vehicle.categoryId,
        name: vehicle.categoryName,
        vehicles: [vehicle],
      });
    }
  }
  return Array.from(byCategory.values());
}
