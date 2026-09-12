// A rental DAY is a 24-hour period from handover, not a calendar day.
// Partial days round up, minimum 1, after billingGraceMinutes is subtracted
// from the raw duration.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const HOURS_PER_DAY = 24;

export type RentalDaysResult = { ok: true; days: number } | { ok: false; reason: "INVALID_DATE_RANGE" };

export function rentalDays(pickupAt: Date, returnAt: Date, graceMinutes: number): RentalDaysResult {
  if (returnAt.getTime() <= pickupAt.getTime()) {
    return { ok: false, reason: "INVALID_DATE_RANGE" };
  }

  const durationMs = returnAt.getTime() - pickupAt.getTime();
  const graceMs = graceMinutes * MS_PER_MINUTE;
  const effectiveMs = Math.max(0, durationMs - graceMs);
  const hours = effectiveMs / MS_PER_HOUR;
  const days = Math.max(1, Math.ceil(hours / HOURS_PER_DAY));

  return { ok: true, days };
}
