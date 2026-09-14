import { afterAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { PrismaClient, type UserRole } from "@prisma/client";
import { hashPassword } from "../lib/auth/password";
import { createSession, prisma as sessionPrisma } from "../lib/auth/session";
import { authorize, roleSatisfies } from "../lib/auth/guard";
import { ADMIN_NAV_ITEMS } from "../lib/admin/nav";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();
const userIds: string[] = [];

async function sessionFor(role: UserRole): Promise<string> {
  const passwordHash = await hashPassword("Correct-Horse-Battery-1!");
  const user = await prisma.user.create({
    data: {
      email: `admin-shell-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      name: "Test User",
      role,
      isActive: true,
      passwordHash,
    },
  });
  userIds.push(user.id);
  const session = await createSession(user.id, {}, new Date());
  return session.rawToken;
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await sessionPrisma.$disconnect();
});

// Maps a nav route to the page.tsx file that implements it, for the
// requireAuth-presence check in the last describe block below.
const ROUTE_FILES: Record<string, string> = {
  "/admin": "app/admin/(authenticated)/page.tsx",
  "/admin/bookings": "app/admin/(authenticated)/bookings/page.tsx",
  "/admin/calendar": "app/admin/(authenticated)/calendar/page.tsx",
  "/admin/fleet": "app/admin/(authenticated)/fleet/page.tsx",
  "/admin/customers": "app/admin/(authenticated)/customers/page.tsx",
  "/admin/payments": "app/admin/(authenticated)/payments/page.tsx",
  "/admin/reports": "app/admin/(authenticated)/reports/page.tsx",
  "/admin/locations": "app/admin/(authenticated)/locations/page.tsx",
  "/admin/pricing": "app/admin/(authenticated)/pricing/page.tsx",
  "/admin/cms": "app/admin/(authenticated)/cms/page.tsx",
  "/admin/settings": "app/admin/(authenticated)/settings/page.tsx",
  "/admin/audit": "app/admin/(authenticated)/audit/page.tsx",
};

describe("admin shell: nav config covers all 12 routes", () => {
  it("1. ADMIN_NAV_ITEMS has exactly 12 entries with a file mapping for each", () => {
    expect(ADMIN_NAV_ITEMS.length).toBe(12);
    for (const item of ADMIN_NAV_ITEMS) {
      expect(ROUTE_FILES[item.href]).toBeDefined();
    }
  });
});

describe("admin shell: unauthenticated access", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    it(`2. no session is denied for ${item.href} (minimum role ${item.minRole})`, async () => {
      const outcome = await authorize(undefined, item.minRole);
      expect(outcome.ok).toBe(false);
    });
  }
});

describe("admin shell: role-gated access per route", () => {
  const roleOrder: UserRole[] = ["STAFF", "MANAGER", "ADMIN", "OWNER"];

  for (const actingRole of roleOrder) {
    it(`3. a ${actingRole} session reaches exactly the routes its rank satisfies`, async () => {
      const token = await sessionFor(actingRole);

      for (const item of ADMIN_NAV_ITEMS) {
        const outcome = await authorize(token, item.minRole);
        const shouldReach = roleSatisfies(actingRole, item.minRole);
        expect(outcome.ok, `${actingRole} vs ${item.href} (min ${item.minRole})`).toBe(shouldReach);
      }
    });
  }
});

describe("admin shell: every route file calls requireAuth", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    it(`4. ${ROUTE_FILES[item.href]} calls requireAuth("${item.minRole}")`, () => {
      const source = fs.readFileSync(path.resolve(process.cwd(), ROUTE_FILES[item.href]), "utf8");
      expect(source).toMatch(/requireAuth\(/);
      expect(source).toContain(`requireAuth("${item.minRole}")`);
    });
  }

  it("5. app/admin/(authenticated)/layout.tsx also calls requireAuth(\"STAFF\") as the outer gate", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/(authenticated)/layout.tsx"), "utf8");
    expect(source).toContain('requireAuth("STAFF")');
  });

  it("6. app/admin/login/page.tsx is NOT guarded by requireAuth — it must render for unauthenticated visitors", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "app/admin/login/page.tsx"), "utf8");
    expect(source).not.toMatch(/requireAuth\(/);
  });

  it("7. app/admin/login/page.tsx sits outside the (authenticated) route group that carries the requireAuth layout gate", () => {
    expect(fs.existsSync(path.resolve(process.cwd(), "app/admin/(authenticated)/login"))).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), "app/admin/login/page.tsx"))).toBe(true);
  });
});
