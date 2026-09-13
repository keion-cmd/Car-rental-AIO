import { afterAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { PrismaClient, type UserRole } from "@prisma/client";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import {
  createSession,
  getSessionFromToken,
  revokeAllSessionsForUser,
  prisma as sessionPrisma,
} from "../lib/auth/session";
import { login, changePassword, prisma as authPrisma } from "../lib/services/auth.service";
import { authorize, roleSatisfies } from "../lib/auth/guard";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });

const prisma = new PrismaClient();

const userIds: string[] = [];

async function createUser(
  overrides: { email?: string; password?: string; role?: UserRole; isActive?: boolean } = {}
): Promise<{ user: Awaited<ReturnType<typeof prisma.user.create>>; password: string }> {
  const email = overrides.email ?? `auth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = overrides.password ?? "Correct-Horse-Battery-1!";
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      name: "Test User",
      role: overrides.role ?? "STAFF",
      isActive: overrides.isActive ?? true,
      passwordHash,
    },
  });
  userIds.push(user.id);
  return { user, password };
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await sessionPrisma.$disconnect();
  await authPrisma.$disconnect();
});

describe("password hashing", () => {
  it("1. hashPassword then verifyPassword returns true for the correct password", async () => {
    const hash = await hashPassword("s3cret-Pass!");
    await expect(verifyPassword("s3cret-Pass!", hash)).resolves.toBe(true);
  });

  it("2. a wrong password returns false", async () => {
    const hash = await hashPassword("s3cret-Pass!");
    await expect(verifyPassword("totally-different", hash)).resolves.toBe(false);
  });

  it("3. the same password hashed twice produces different stored values", async () => {
    const first = await hashPassword("s3cret-Pass!");
    const second = await hashPassword("s3cret-Pass!");
    expect(first).not.toBe(second);
  });

  it("4. the stored value does not contain the plaintext", async () => {
    const plain = "s3cret-Pass!";
    const hash = await hashPassword(plain);
    expect(hash.includes(plain)).toBe(false);
  });
});

describe("sessions", () => {
  it("5. createSession returns a raw token; the database stores a different value", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");
    const session = await createSession(user.id, {}, now);
    expect(session.rawToken.length).toBeGreaterThan(0);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    expect(row.tokenHash).not.toBe(session.rawToken);
  });

  it("6. getSessionFromToken with the raw token resolves the user", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");
    const session = await createSession(user.id, {}, now);

    const resolved = await getSessionFromToken(session.rawToken, now);
    expect(resolved?.userId).toBe(user.id);
    expect(resolved?.user.email).toBe(user.email);
  });

  it("7. a tampered token resolves to null", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");
    const session = await createSession(user.id, {}, now);
    const tampered = session.rawToken.slice(0, -1) + (session.rawToken.endsWith("A") ? "B" : "A");

    const resolved = await getSessionFromToken(tampered, now);
    expect(resolved).toBeNull();
  });

  it("8. an expired session (frozen now) resolves to null", async () => {
    const { user } = await createUser();
    const createdAt = new Date("2030-01-01T00:00:00Z");
    const session = await createSession(user.id, {}, createdAt);

    const wayAfterExpiry = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    const resolved = await getSessionFromToken(session.rawToken, wayAfterExpiry);
    expect(resolved).toBeNull();
  });

  it("9. a revoked session resolves to null", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");
    const session = await createSession(user.id, {}, now);
    await prisma.session.update({ where: { id: session.sessionId }, data: { revokedAt: now } });

    const resolved = await getSessionFromToken(session.rawToken, now);
    expect(resolved).toBeNull();
  });

  it("10. revokeAllSessionsForUser invalidates every session for that user and none for another", async () => {
    const { user: userA } = await createUser();
    const { user: userB } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    const sessionA1 = await createSession(userA.id, {}, now);
    const sessionA2 = await createSession(userA.id, {}, now);
    const sessionB1 = await createSession(userB.id, {}, now);

    await revokeAllSessionsForUser(userA.id, now);

    expect(await getSessionFromToken(sessionA1.rawToken, now)).toBeNull();
    expect(await getSessionFromToken(sessionA2.rawToken, now)).toBeNull();
    expect((await getSessionFromToken(sessionB1.rawToken, now))?.userId).toBe(userB.id);
  });
});

describe("login", () => {
  it("11. correct credentials return a session and reset failedLoginAttempts", async () => {
    const { user, password } = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 3 } });
    const now = new Date("2030-01-01T00:00:00Z");

    const outcome = await login(user.email, password, {}, now);
    expect(outcome.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lastLoginAt?.getTime()).toBe(now.getTime());
  });

  it("12. a wrong password increments failedLoginAttempts", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    const outcome = await login(user.email, "wrong-password", {}, now);
    expect(outcome).toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginAttempts).toBe(1);
  });

  it("13. five failures set lockedUntil; the sixth attempt returns ACCOUNT_LOCKED even with the correct password", async () => {
    const { user, password } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    for (let i = 0; i < 5; i++) {
      const outcome = await login(user.email, "wrong-password", {}, now);
      expect(outcome).toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });
    }

    const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil).not.toBeNull();

    const sixth = await login(user.email, password, {}, now);
    expect(sixth).toEqual({ ok: false, reason: "ACCOUNT_LOCKED" });
  });

  it("14. after lockedUntil passes (frozen now), a correct password succeeds and clears the lock", async () => {
    const { user, password } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    for (let i = 0; i < 5; i++) {
      await login(user.email, "wrong-password", {}, now);
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil).not.toBeNull();

    const afterLockout = new Date(locked.lockedUntil!.getTime() + 1000);
    const outcome = await login(user.email, password, {}, afterLockout);
    expect(outcome.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLoginAttempts).toBe(0);
  });

  it("15. an unknown email and a wrong password return the identical rejection reason", async () => {
    const { user } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    const unknownEmailOutcome = await login("no-such-user-xyz@example.com", "whatever", {}, now);
    const wrongPasswordOutcome = await login(user.email, "wrong-password", {}, now);

    // Indistinguishability is asserted by deep-equality of the full outcome
    // shape, not just the reason string — a caller inspecting either
    // rejection sees byte-for-byte the same structure.
    expect(unknownEmailOutcome).toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });
    expect(wrongPasswordOutcome).toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });
    expect(unknownEmailOutcome).toEqual(wrongPasswordOutcome);
  });

  it("16. an inactive user cannot log in", async () => {
    const { user, password } = await createUser({ isActive: false });
    const now = new Date("2030-01-01T00:00:00Z");

    const outcome = await login(user.email, password, {}, now);
    expect(outcome.ok).toBe(false);
  });

  it("17. email is normalised — differing case and whitespace resolve to the same user", async () => {
    const { user, password } = await createUser({ email: `norm-${Date.now()}@example.com` });
    const now = new Date("2030-01-01T00:00:00Z");

    const outcome = await login(`  ${user.email.toUpperCase()}  `, password, {}, now);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.user.id).toBe(user.id);
    }
  });
});

describe("authorisation", () => {
  it("18. role hierarchy: OWNER satisfies a MANAGER requirement; STAFF does not", () => {
    expect(roleSatisfies("OWNER", "MANAGER")).toBe(true);
    expect(roleSatisfies("STAFF", "MANAGER")).toBe(false);
  });

  it("19. a request with no session is denied", async () => {
    const outcome = await authorize(undefined, "STAFF");
    expect(outcome.ok).toBe(false);
  });

  it("20. a valid session with insufficient role is denied", async () => {
    const { user, password } = await createUser({ role: "STAFF" });
    const now = new Date("2030-01-01T00:00:00Z");
    const loginOutcome = await login(user.email, password, {}, now);
    if (!loginOutcome.ok) throw new Error("expected login to succeed");

    const outcome = await authorize(loginOutcome.rawToken, "MANAGER", now);
    expect(outcome.ok).toBe(false);
  });

  it("21. changePassword with the correct current password succeeds, revokes other sessions, and keeps the current one alive", async () => {
    const { user, password } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    const currentLogin = await login(user.email, password, {}, now);
    const otherLogin = await login(user.email, password, {}, now);
    if (!currentLogin.ok || !otherLogin.ok) throw new Error("expected both logins to succeed");

    const outcome = await changePassword(
      user.id,
      password,
      "New-Password-9!",
      { currentSessionId: currentLogin.sessionId },
      now
    );
    expect(outcome).toEqual({ ok: true });

    // The session that performed the change survives; every other session
    // for this user is revoked.
    expect((await getSessionFromToken(currentLogin.rawToken, now))?.userId).toBe(user.id);
    expect(await getSessionFromToken(otherLogin.rawToken, now)).toBeNull();
  });

  it("22. changePassword with a wrong current password fails and revokes nothing", async () => {
    const { user, password } = await createUser();
    const now = new Date("2030-01-01T00:00:00Z");

    const session = await login(user.email, password, {}, now);
    if (!session.ok) throw new Error("expected login to succeed");

    const outcome = await changePassword(user.id, "wrong-current-password", "New-Password-9!", {}, now);
    expect(outcome).toEqual({ ok: false, reason: "INVALID_CURRENT_PASSWORD" });

    expect((await getSessionFromToken(session.rawToken, now))?.userId).toBe(user.id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(verifyPassword(password, row.passwordHash)).resolves.toBe(true);
  });
});
