"use server";

import { redirect } from "next/navigation";
import { requireAuth } from "../../lib/auth/guard";
import { parseMoneyInput } from "../../lib/money";
import {
  createVehicle,
  updateVehicle,
  archiveVehicle,
  setBookableOnline,
  addVehicleImage,
  removeVehicleImage,
  reorderImages,
  setPrimaryImage,
  createMaintenance,
  completeMaintenance,
  createManualBlock,
  removeManualBlock,
} from "../../lib/services/fleet.service";
import type { VehicleTransmission, VehicleFuelType, MaintenanceType } from "@prisma/client";

// Thin "use server" wrappers around lib/services/fleet.service.ts, same
// separation as app/actions/bookings.ts and check-in-out.ts: redirect() is
// a framework signal that only makes sense here, all business logic stays
// independently testable in the service.

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optionalStr(formData: FormData, key: string): string | undefined {
  const v = str(formData, key);
  return v ? v : undefined;
}

function toRejectionSlug(reason: string): string {
  return reason.toLowerCase().replace(/_/g, "-");
}

export async function createVehicleAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");

  const dailyRate = parseMoneyInput(str(formData, "dailyRate"));
  const securityDepositRaw = optionalStr(formData, "securityDeposit");
  const securityDeposit = securityDepositRaw ? parseMoneyInput(securityDepositRaw) : BigInt(0);
  const seats = Number(str(formData, "seats"));

  if (dailyRate === null || securityDeposit === null || !Number.isInteger(seats)) {
    redirect(`/admin/fleet/new?error=invalid-input`);
  }

  const { id } = await createVehicle({
    plateNumber: str(formData, "plateNumber"),
    categoryId: str(formData, "categoryId"),
    make: str(formData, "make"),
    model: str(formData, "model"),
    seats,
    transmission: str(formData, "transmission") as VehicleTransmission,
    fuelType: str(formData, "fuelType") as VehicleFuelType,
    homeLocationId: str(formData, "homeLocationId"),
    currentLocationId: str(formData, "currentLocationId") || str(formData, "homeLocationId"),
    dailyRate,
    securityDeposit,
    minDriverAge: Number(str(formData, "minDriverAge")) || 21,
    minRentalDays: Number(str(formData, "minRentalDays")) || 1,
  });

  redirect(`/admin/fleet/${id}`);
}

export async function updateVehicleAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");

  const dailyRate = parseMoneyInput(str(formData, "dailyRate"));
  const securityDeposit = parseMoneyInput(str(formData, "securityDeposit"));
  const weeklyRateRaw = optionalStr(formData, "weeklyRate");
  const monthlyRateRaw = optionalStr(formData, "monthlyRate");
  const extraKmRateRaw = optionalStr(formData, "extraKmRate");
  const weeklyRate = weeklyRateRaw ? parseMoneyInput(weeklyRateRaw) : null;
  const monthlyRate = monthlyRateRaw ? parseMoneyInput(monthlyRateRaw) : null;
  const extraKmRate = extraKmRateRaw ? parseMoneyInput(extraKmRateRaw) : null;

  // weeklyRate/monthlyRate/extraKmRate: null means "not set", a valid value
  // — only a non-empty string that fails to parse is an input error.
  if (
    dailyRate === null ||
    securityDeposit === null ||
    (weeklyRateRaw && weeklyRate === null) ||
    (monthlyRateRaw && monthlyRate === null) ||
    (extraKmRateRaw && extraKmRate === null)
  ) {
    redirect(`/admin/fleet/${vehicleId}?tab=pricing&error=invalid-input`);
  }

  const includedKmPerDayRaw = optionalStr(formData, "includedKmPerDay");
  const maxRentalDaysRaw = optionalStr(formData, "maxRentalDays");

  await updateVehicle(vehicleId, {
    dailyRate,
    securityDeposit,
    weeklyRate,
    monthlyRate,
    extraKmRate,
    includedKmPerDay: includedKmPerDayRaw ? Number(includedKmPerDayRaw) : null,
    minRentalDays: Number(str(formData, "minRentalDays")) || 1,
    maxRentalDays: maxRentalDaysRaw ? Number(maxRentalDaysRaw) : null,
    minDriverAge: Number(str(formData, "minDriverAge")) || 21,
  });

  redirect(`/admin/fleet/${vehicleId}?tab=pricing`);
}

export async function archiveVehicleAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");

  const outcome = await archiveVehicle(vehicleId);
  if (!outcome.ok) {
    const refs = outcome.conflicts.map((c) => c.reference).join(",");
    redirect(`/admin/fleet/${vehicleId}?error=has-future-bookings&conflicts=${encodeURIComponent(refs)}`);
  }

  redirect(`/admin/fleet/${vehicleId}`);
}

export async function setBookableOnlineAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const value = str(formData, "value") === "true";

  await setBookableOnline(vehicleId, value);
  redirect(`/admin/fleet/${vehicleId}?tab=availability`);
}

export async function addVehicleImageAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const url = str(formData, "url");

  if (!url) {
    redirect(`/admin/fleet/${vehicleId}?tab=overview&error=invalid-input`);
  }

  await addVehicleImage(vehicleId, url);
  redirect(`/admin/fleet/${vehicleId}?tab=overview`);
}

export async function removeVehicleImageAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const imageId = str(formData, "imageId");

  await removeVehicleImage(imageId);
  redirect(`/admin/fleet/${vehicleId}?tab=overview`);
}

export async function setPrimaryImageAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const imageId = str(formData, "imageId");

  await setPrimaryImage(vehicleId, imageId);
  redirect(`/admin/fleet/${vehicleId}?tab=overview`);
}

export async function reorderImagesAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const orderedIds = str(formData, "orderedImageIds").split(",").filter(Boolean);

  await reorderImages(vehicleId, orderedIds);
  redirect(`/admin/fleet/${vehicleId}?tab=overview`);
}

export async function createMaintenanceAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const scheduledAt = new Date(str(formData, "scheduledAt"));
  const endAt = new Date(str(formData, "endAt"));

  if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= scheduledAt) {
    redirect(`/admin/fleet/${vehicleId}?tab=maintenance&error=invalid-input`);
  }

  const outcome = await createMaintenance({
    vehicleId,
    type: str(formData, "type") as MaintenanceType,
    scheduledAt,
    endAt,
    notes: optionalStr(formData, "notes"),
  });

  if (!outcome.ok) {
    const refs = outcome.conflicts.map((c) => c.reference).join(",");
    redirect(`/admin/fleet/${vehicleId}?tab=maintenance&error=${toRejectionSlug(outcome.reason)}&conflicts=${encodeURIComponent(refs)}`);
  }

  redirect(`/admin/fleet/${vehicleId}?tab=maintenance`);
}

export async function completeMaintenanceAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const maintenanceId = str(formData, "maintenanceId");

  await completeMaintenance(maintenanceId);
  redirect(`/admin/fleet/${vehicleId}?tab=maintenance`);
}

export async function createManualBlockAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const start = new Date(str(formData, "start"));
  const end = new Date(str(formData, "end"));

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    redirect(`/admin/fleet/${vehicleId}?tab=availability&error=invalid-input`);
  }

  const outcome = await createManualBlock({ vehicleId, start, end });
  if (!outcome.ok) {
    redirect(`/admin/fleet/${vehicleId}?tab=availability&error=${toRejectionSlug(outcome.reason)}`);
  }

  redirect(`/admin/fleet/${vehicleId}?tab=availability`);
}

export async function removeManualBlockAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");
  const vehicleId = str(formData, "vehicleId");
  const blockId = str(formData, "blockId");

  await removeManualBlock(blockId);
  redirect(`/admin/fleet/${vehicleId}?tab=availability`);
}
