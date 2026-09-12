import { z } from "zod";

export const quoteVehicleInputSchema = z.object({
  dailyRate: z.bigint(),
  weeklyRate: z.bigint().nullable(),
  monthlyRate: z.bigint().nullable(),
  securityDeposit: z.bigint(),
  minRentalDays: z.number().int().positive(),
  maxRentalDays: z.number().int().positive().nullable(),
  minDriverAge: z.number().int().nonnegative(),
});

export const quoteSettingsInputSchema = z.object({
  currency: z.string().min(1),
  taxRateBps: z.number().int().nonnegative(),
  youngDriverMaxAge: z.number().int().nonnegative(),
  youngDriverSurchargePerDay: z.bigint(),
  billingGraceMinutes: z.number().int().nonnegative(),
});

export const quoteLocationPairInputSchema = z
  .object({
    isAllowed: z.boolean(),
    feeAmount: z.bigint(),
  })
  .nullable();

export const quoteInputSchema = z.object({
  vehicle: quoteVehicleInputSchema,
  pickupLocationId: z.string().uuid(),
  returnLocationId: z.string().uuid(),
  pickupAt: z.date(),
  returnAt: z.date(),
  driverDateOfBirth: z.date(),
  now: z.date(),
  settings: quoteSettingsInputSchema,
  locationPair: quoteLocationPairInputSchema,
});

export type QuoteInputPayload = z.infer<typeof quoteInputSchema>;
