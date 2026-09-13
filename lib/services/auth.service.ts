import { PrismaClient, type UserRole } from "@prisma/client";
import { hashPassword, verifyPassword } from "../auth/password";
import { createSession, revokeSession, revokeAllSessionsForUser, type SessionMeta } from "../auth/session";

export const prisma = new PrismaClient();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// A fixed dummy hash, scrypt'd once and reused, so an unknown-email login
// still pays the cost of a password comparison — the branch shape (and
// roughly its cost) matches the known-email/wrong-password branch instead
// of returning instantly and leaking, via timing, that the email doesn't
// exist.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("no-such-account-timing-parity-only");
  }
  return dummyHashPromise;
}

export type LoginRejectionReason = "INVALID_CREDENTIALS" | "ACCOUNT_LOCKED" | "ACCOUNT_INACTIVE";

export interface LoginSuccess {
  ok: true;
  sessionId: string;
  rawToken: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string; role: UserRole };
}

export type LoginOutcome = LoginSuccess | { ok: false; reason: LoginRejectionReason };

// Never throws — every rejection is a returned value so callers (the
// server action backing /admin/login) can render the same generic message
// regardless of cause. The one exception to "generic" is ACCOUNT_LOCKED,
// which is intentionally distinguishable (a locked-out staff member needs
// to know to wait, not to keep guessing) — it is never returned for an
// unknown email, only for a real, locked account, so it does not leak
// account existence for a random guess.
export async function login(email: string, password: string, meta: SessionMeta = {}, now: Date = new Date()): Promise<LoginOutcome> {
  const normalised = normaliseEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalised } });

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    return { ok: false, reason: "ACCOUNT_LOCKED" };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000) : user.lockedUntil,
      },
    });
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  // Correct password, but the account is deactivated. Returns the same
  // INVALID_CREDENTIALS reason as a wrong password (per spec: "same generic
  // failure as a wrong password") so a caller who already knows the
  // password cannot use the response to learn the account was deactivated.
  // Deliberately does not touch failedLoginAttempts/lockedUntil — the
  // credentials were correct, this isn't a guessing attempt.
  if (!user.isActive) {
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
  });

  const session = await createSession(user.id, meta, now);
  return {
    ok: true,
    sessionId: session.sessionId,
    rawToken: session.rawToken,
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}

export async function logout(sessionId: string, now: Date = new Date()): Promise<void> {
  await revokeSession(sessionId, now);
}

export interface ChangePasswordMeta {
  // The session performing the change — kept alive while every other
  // session for this user is revoked. Omit to revoke all sessions,
  // including the current one.
  currentSessionId?: string;
}

export type ChangePasswordOutcome = { ok: true } | { ok: false; reason: "INVALID_CURRENT_PASSWORD" };

export async function changePassword(
  userId: string,
  currentPassword: string,
  nextPassword: string,
  meta: ChangePasswordMeta = {},
  now: Date = new Date()
): Promise<ChangePasswordOutcome> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return { ok: false, reason: "INVALID_CURRENT_PASSWORD" };
  }

  const nextHash = await hashPassword(nextPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: nextHash } });
  await revokeAllSessionsForUser(userId, now, meta.currentSessionId);
  return { ok: true };
}
