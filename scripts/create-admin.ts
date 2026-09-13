import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth/password";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

// Bootstraps the first OWNER account. Reads credentials from the
// environment only — never hardcoded, never printed, never committed. See
// docs/HANDOFF.md for the ADMIN_EMAIL/ADMIN_PASSWORD variable names.
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD must both be set in the environment.");
    process.exitCode = 1;
    return;
  }

  const normalisedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalisedEmail } });
  if (existing) {
    console.error(`A user with email ${normalisedEmail} already exists. Refusing to overwrite it.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email: normalisedEmail,
      name: "Owner",
      role: "OWNER",
      passwordHash,
    },
  });

  console.log(`Created OWNER account ${user.email} (id ${user.id}). Password was not logged.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
