import crypto from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";

export const prisma = new PrismaClient();

// Opaque, database-backed tokens — not JWT — because revocability is the
// point for staff accounts: a compromised or offboarded staff session must
// be killable server-side, which a self-contained signed token cannot be.
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export interface SessionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreateSessionResult {
  sessionId: string;
  rawToken: string;
  expiresAt: Date;
}

// Returns the raw token exactly once — the caller (auth.service's login())
// is responsible for handing it to the client as a cookie. Only its SHA-256
// is persisted, so a leaked database dump cannot be replayed as a live
// session.
export async function createSession(
  userId: string,
  meta: SessionMeta = {},
  now: Date = new Date()
): Promise<CreateSessionResult> {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      lastSeenAt: now,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  return { sessionId: session.id, rawToken, expiresAt };
}

export interface ResolvedSessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  user: ResolvedSessionUser;
}

// A tampered token hashes to a value with no matching row, so this returns
// null the same way an unknown token does — no separate "tampered" branch
// exists to leak information through. `now` is always the caller's clock,
// never read from the system here, so expiry checks stay testable.
export async function getSessionFromToken(rawToken: string, now: Date = new Date()): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session) {
    return null;
  }
  if (session.revokedAt) {
    return null;
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return {
    sessionId: session.id,
    userId: session.userId,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      isActive: session.user.isActive,
    },
  };
}

export async function revokeSession(sessionId: string, now: Date = new Date()): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
}

// exceptSessionId lets changePassword() keep the session that performed the
// change alive while killing every other outstanding session for the user —
// without it, all sessions (including the caller's) are revoked.
export async function revokeAllSessionsForUser(
  userId: string,
  now: Date = new Date(),
  exceptSessionId?: string
): Promise<void> {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: now },
  });
}

export async function cleanupExpiredSessions(now: Date = new Date()): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
}
