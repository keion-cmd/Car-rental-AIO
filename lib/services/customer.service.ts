import { PrismaClient, type CustomerFlag } from "@prisma/client";
import type { DbClient } from "./availability.service";

export const prisma = new PrismaClient();

export interface FindOrCreateCustomerInput {
  email: string;
  name: string;
  phone?: string | null;
  dateOfBirth?: Date | null;
}

// Concurrency: an upsert on the unique email column, not catch-and-reread.
// Prisma compiles this to a single atomic INSERT ... ON CONFLICT (email) on
// Postgres, so two simultaneous callers with the same email cannot both
// win the create.
//
// Email is normalised (trimmed, lowercased) before the upsert so a repeat
// guest always dedupes onto one row. Never updates email. name/phone are
// backfilled only when currently null, via a conditional UPDATE ... WHERE
// column IS NULL — an atomic check-and-set that never overwrites a
// non-null value already on file.
export async function findOrCreateCustomer(input: FindOrCreateCustomerInput, tx: DbClient = prisma) {
  const email = input.email.trim().toLowerCase();

  await tx.customer.upsert({
    where: { email },
    create: {
      email,
      name: input.name,
      phone: input.phone ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
    },
    update: {},
  });

  if (input.phone) {
    await tx.customer.updateMany({ where: { email, phone: null }, data: { phone: input.phone } });
  }
  if (input.dateOfBirth) {
    await tx.customer.updateMany({ where: { email, dateOfBirth: null }, data: { dateOfBirth: input.dateOfBirth } });
  }

  return tx.customer.findUniqueOrThrow({ where: { email } });
}

export interface FlagOptions {
  tx?: DbClient;
  now?: Date;
}

export type SetCustomerFlagOutcome = { ok: true } | { ok: false; reason: "FLAG_REASON_REQUIRED" };

// reason is required whenever a flag is set — a blacklist with no recorded
// reason is unusable in a dispute and indistinguishable from a mistake.
// Enforced here, not in the schema, so a blank reason returns a structured
// rejection instead of a raw constraint failure, and writes nothing.
export async function setCustomerFlag(
  customerId: string,
  flag: CustomerFlag,
  reason: string,
  staffUserId: string,
  options: FlagOptions = {}
): Promise<SetCustomerFlagOutcome> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return { ok: false, reason: "FLAG_REASON_REQUIRED" };
  }

  const db = options.tx ?? prisma;
  const now = options.now ?? new Date();

  await db.customer.update({
    where: { id: customerId },
    data: { flag, flagReason: trimmedReason, flaggedAt: now, flaggedById: staffUserId },
  });

  return { ok: true };
}

export async function clearCustomerFlag(customerId: string, staffUserId: string, options: FlagOptions = {}): Promise<void> {
  const db = options.tx ?? prisma;
  void staffUserId; // no history table in this phase — clearing simply unsets the four fields.
  await db.customer.update({
    where: { id: customerId },
    data: { flag: null, flagReason: null, flaggedAt: null, flaggedById: null },
  });
}

export interface UpdateStaffNotesOptions {
  tx?: DbClient;
}

// The only write path for Customer.staffNotes — internal only, same
// convention as Booking.staffNotes in booking.service.ts.
export async function updateStaffNotes(customerId: string, notes: string, options: UpdateStaffNotesOptions = {}): Promise<void> {
  const db = options.tx ?? prisma;
  await db.customer.update({ where: { id: customerId }, data: { staffNotes: notes } });
}

// BLACKLIST MUST ACTUALLY BLOCK — this is the single check booking-flow.service
// calls, inside its transaction, before a booking is created.
export async function isCustomerBlocked(customerId: string, options: { tx?: DbClient } = {}): Promise<boolean> {
  const db = options.tx ?? prisma;
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { flag: true } });
  return customer?.flag === "BLACKLISTED";
}
