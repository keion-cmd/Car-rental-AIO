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

function fakePlate(index: number) {
  const letters = String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + ((index + 3) % 26)) + String.fromCharCode(65 + ((index + 7) % 26));
  const digits = String(1000 + index).slice(-4);
  return `TEST ${letters} ${digits}`;
}

async function main() {
  await prisma.settings.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      currency: "PHP",
      defaultTurnaroundMinutes: 90,
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
      await prisma.locationPair.upsert({
        where: { fromLocationId_toLocationId: { fromLocationId: from.id, toLocationId: to.id } },
        update: {},
        create: {
          fromLocationId: from.id,
          toLocationId: to.id,
          isAllowed: true,
          feeAmount: 0,
          minTransferHours: 2,
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
    const model = models[i % models.length];
    const plateNumber = fakePlate(i);
    await prisma.vehicle.upsert({
      where: { plateNumber },
      update: {},
      create: {
        modelId: model.id,
        plateNumber,
        homeLocationId: homeLocation.id,
        currentLocationId: homeLocation.id,
        isBookableOnline: true,
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
