import { PrismaClient, VehicleTransmission, VehicleFuelType } from "@prisma/client";

const prisma = new PrismaClient();

const OPENING_HOURS = {
  mon: { open: "08:00", close: "20:00" },
  tue: { open: "08:00", close: "20:00" },
  wed: { open: "08:00", close: "20:00" },
  thu: { open: "08:00", close: "20:00" },
  fri: { open: "08:00", close: "20:00" },
  sat: { open: "08:00", close: "18:00" },
  sun: { open: "08:00", close: "18:00" },
};

const LOCATIONS = [
  { name: "Cebu Airport", timezone: "Asia/Manila", isAirport: true },
  { name: "Cebu City Downtown", timezone: "Asia/Manila", isAirport: false },
  { name: "Mactan Branch", timezone: "Asia/Manila", isAirport: false },
  { name: "Lapu-Lapu Branch", timezone: "Asia/Manila", isAirport: false },
];

const CATEGORIES = ["Economy", "SUV", "Van", "Luxury"];

const MODELS: Array<{
  category: string;
  make: string;
  model: string;
  seats: number;
  transmission: VehicleTransmission;
  fuelType: VehicleFuelType;
}> = [
  { category: "Economy", make: "Toyota", model: "Vios", seats: 5, transmission: "AUTOMATIC", fuelType: "PETROL" },
  { category: "Economy", make: "Honda", model: "Brio", seats: 5, transmission: "MANUAL", fuelType: "PETROL" },
  { category: "SUV", make: "Toyota", model: "Fortuner", seats: 7, transmission: "AUTOMATIC", fuelType: "DIESEL" },
  { category: "SUV", make: "Mitsubishi", model: "Montero Sport", seats: 7, transmission: "AUTOMATIC", fuelType: "DIESEL" },
  { category: "Van", make: "Toyota", model: "Hiace", seats: 12, transmission: "MANUAL", fuelType: "DIESEL" },
  { category: "Luxury", make: "Toyota", model: "Camry", seats: 5, transmission: "AUTOMATIC", fuelType: "HYBRID" },
];

// Daily rates in centavos (PHP minor units), spread across categories.
const DAILY_RATE_BY_CATEGORY: Record<string, number> = {
  Economy: 180000, // PHP 1,800
  SUV: 320000, // PHP 3,200
  Van: 280000, // PHP 2,800
  Luxury: 450000, // PHP 4,500
};

const SECURITY_DEPOSIT_BY_CATEGORY: Record<string, number> = {
  Economy: 500000, // PHP 5,000
  SUV: 900000, // PHP 9,000
  Van: 800000, // PHP 8,000
  Luxury: 1500000, // PHP 15,000
};

function fakePlate(index: number) {
  const letters = String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + ((index + 3) % 26)) + String.fromCharCode(65 + ((index + 7) % 26));
  const digits = String(1000 + index).slice(-4);
  return `TEST ${letters} ${digits}`;
}

async function main() {
  const settingsData = {
    currency: "PHP",
    defaultTurnaroundMinutes: 90,
    taxRateBps: 1200,
    youngDriverMaxAge: 24,
    youngDriverSurchargePerDay: 40000,
    billingGraceMinutes: 59,
  };
  await prisma.settings.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: settingsData,
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      ...settingsData,
    },
  });

  const locations = [];
  for (const loc of LOCATIONS) {
    const existing = await prisma.location.findFirst({ where: { name: loc.name } });
    const location =
      existing ??
      (await prisma.location.create({
        data: {
          name: loc.name,
          timezone: loc.timezone,
          openingHours: OPENING_HOURS,
          isAirport: loc.isAirport,
        },
      }));
    locations.push(location);
  }

  for (const from of locations) {
    for (const to of locations) {
      if (from.id === to.id) continue;
      // Deterministic one-way fee: airport legs cost more than branch-to-branch.
      // Fees are in centavos (PHP minor units).
      const isAirportLeg = from.isAirport || to.isAirport;
      const feeAmount = isAirportLeg ? 50000 : 30000;
      // Lapu-Lapu Branch -> Cebu Airport is deliberately disallowed so the
      // rejection path is testable.
      const isAllowed = !(from.name === "Lapu-Lapu Branch" && to.name === "Cebu Airport");
      const pairData = {
        isAllowed,
        feeAmount,
        minTransferHours: 2,
      };
      await prisma.locationPair.upsert({
        where: { fromLocationId_toLocationId: { fromLocationId: from.id, toLocationId: to.id } },
        update: pairData,
        create: {
          fromLocationId: from.id,
          toLocationId: to.id,
          ...pairData,
        },
      });
    }
  }

  const categories: Record<string, { id: string }> = {};
  for (const name of CATEGORIES) {
    categories[name] = await prisma.vehicleCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  const models = [];
  for (const m of MODELS) {
    const existing = await prisma.vehicleModel.findFirst({
      where: { make: m.make, model: m.model, categoryId: categories[m.category].id },
    });
    const model =
      existing ??
      (await prisma.vehicleModel.create({
        data: {
          categoryId: categories[m.category].id,
          make: m.make,
          model: m.model,
          seats: m.seats,
          transmission: m.transmission,
          fuelType: m.fuelType,
        },
      }));
    models.push(model);
  }

  const homeLocation = locations[0];
  for (let i = 0; i < 12; i++) {
    const modelIndex = i % models.length;
    const model = models[modelIndex];
    const categoryName = MODELS[modelIndex].category;
    const plateNumber = fakePlate(i);
    const dailyRate = DAILY_RATE_BY_CATEGORY[categoryName];
    const weeklyRate = dailyRate * 6;
    const monthlyRate = dailyRate * 22;
    const securityDeposit = SECURITY_DEPOSIT_BY_CATEGORY[categoryName];
    const vehicleData = {
      dailyRate,
      weeklyRate,
      monthlyRate,
      securityDeposit,
      includedKmPerDay: 200,
      extraKmRate: 1500, // PHP 15/km
      minRentalDays: 1,
      minDriverAge: 21,
    };
    await prisma.vehicle.upsert({
      where: { plateNumber },
      update: vehicleData,
      create: {
        modelId: model.id,
        plateNumber,
        homeLocationId: homeLocation.id,
        currentLocationId: homeLocation.id,
        isBookableOnline: true,
        ...vehicleData,
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
