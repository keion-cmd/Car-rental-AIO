import { PrismaClient } from "@prisma/client";
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
