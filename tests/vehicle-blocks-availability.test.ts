import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const EXCLUSION_VIOLATION = "23P01";

const prisma = new PrismaClient();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 110 });

let locationId: string;
let modelId: string;
let vehicleAId: string;
let vehicleBId: string;

async function insertBlock(vehicleId: string, startAt: string, endAt: string, blockType = "BOOKING") {
  return pool.query(
    `INSERT INTO vehicle_blocks (vehicle_id, block_type, period, updated_at)
     VALUES ($1::uuid, $2::"BlockType", tstzrange($3::timestamptz, $4::timestamptz, '[)'), now())
     RETURNING id`,
    [vehicleId, blockType, startAt, endAt]
  );
}

beforeAll(async () => {
  const category = await prisma.vehicleCategory.upsert({
    where: { name: "__test_category__" },
    update: {},
    create: { name: "__test_category__" },
  });

  const location = await prisma.location.create({
    data: {
      name: `__test_location__${Date.now()}`,
      timezone: "Asia/Manila",
      openingHours: {},
    },
  });
  locationId = location.id;

  const model = await prisma.vehicleModel.create({
    data: {
      categoryId: category.id,
      make: "TestMake",
      model: "TestModel",
      seats: 5,
      transmission: "AUTOMATIC",
      fuelType: "PETROL",
    },
  });
  modelId = model.id;

  const vehicleA = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `TEST-A-${Date.now()}`,
      homeLocationId: locationId,
      currentLocationId: locationId,
    },
  });
  vehicleAId = vehicleA.id;

  const vehicleB = await prisma.vehicle.create({
    data: {
      modelId,
      plateNumber: `TEST-B-${Date.now()}`,
      homeLocationId: locationId,
      currentLocationId: locationId,
    },
  });
  vehicleBId = vehicleB.id;
});

afterAll(async () => {
  await prisma.vehicleBlock.deleteMany({ where: { vehicleId: { in: [vehicleAId, vehicleBId] } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: [vehicleAId, vehicleBId] } } });
  await prisma.vehicleModel.delete({ where: { id: modelId } });
  await prisma.location.delete({ where: { id: locationId } });
  await pool.end();
  await prisma.$disconnect();
});

describe("vehicle_blocks_no_overlap exclusion constraint", () => {
  it("rejects an identical duplicate period for the same vehicle", async () => {
    await insertBlock(vehicleAId, "2027-01-01T08:00:00Z", "2027-01-01T10:00:00Z");
    await expect(insertBlock(vehicleAId, "2027-01-01T08:00:00Z", "2027-01-01T10:00:00Z")).rejects.toMatchObject({
      code: EXCLUSION_VIOLATION,
    });
  });

  it("rejects a partially overlapping period for the same vehicle", async () => {
    await expect(insertBlock(vehicleAId, "2027-01-01T09:00:00Z", "2027-01-01T11:00:00Z")).rejects.toMatchObject({
      code: EXCLUSION_VIOLATION,
    });
  });

  it("allows a block that starts exactly when another ends (half-open range)", async () => {
    const result = await insertBlock(vehicleAId, "2027-01-01T10:00:00Z", "2027-01-01T12:00:00Z");
    expect(result.rowCount).toBe(1);
  });

  it("allows a non-overlapping block with a gap", async () => {
    const result = await insertBlock(vehicleAId, "2027-01-02T00:00:00Z", "2027-01-02T02:00:00Z");
    expect(result.rowCount).toBe(1);
  });

  it("allows the same overlapping period for a different vehicle", async () => {
    const result = await insertBlock(vehicleBId, "2027-01-01T08:00:00Z", "2027-01-01T10:00:00Z");
    expect(result.rowCount).toBe(1);
  });

  it("rejects overlap regardless of block_type", async () => {
    await expect(insertBlock(vehicleAId, "2027-01-02T00:30:00Z", "2027-01-02T01:30:00Z", "MAINTENANCE")).rejects.toMatchObject({
      code: EXCLUSION_VIOLATION,
    });
  });

  it("rejects an UPDATE that would move a period into overlap with another block", async () => {
    const inserted = await insertBlock(vehicleAId, "2027-01-03T00:00:00Z", "2027-01-03T01:00:00Z");
    const id = inserted.rows[0].id;
    await expect(
      pool.query(
        `UPDATE vehicle_blocks SET period = tstzrange($2::timestamptz, $3::timestamptz, '[)') WHERE id = $1::uuid`,
        [id, "2027-01-02T00:30:00Z", "2027-01-02T01:30:00Z"]
      )
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it("allows insert after the conflicting block is deleted", async () => {
    await pool.query(
      `DELETE FROM vehicle_blocks WHERE vehicle_id = $1::uuid AND period = tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
      [vehicleAId, "2027-01-02T00:00:00Z", "2027-01-02T02:00:00Z"]
    );
    const result = await insertBlock(vehicleAId, "2027-01-02T00:00:00Z", "2027-01-02T02:00:00Z");
    expect(result.rowCount).toBe(1);
  });

  it("under 100 concurrent parallel inserts for the same overlapping period, exactly one succeeds", async () => {
    const start = "2027-06-01T00:00:00Z";
    const end = "2027-06-01T02:00:00Z";
    const attempts = Array.from({ length: 100 }, () => insertBlock(vehicleAId, start, end));
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(99);
    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ code: EXCLUSION_VIOLATION });
      }
    }
  });
});
