import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { getSessionFromToken } from "./session";

export const SESSION_COOKIE_NAME = "session_token";

// One place the role hierarchy is defined. OWNER is the bootstrap
// super-role created by scripts/create-admin.ts; ADMIN/MANAGER/STAFF are
// the pre-existing UserRole values. Higher rank satisfies any lower
// requirement.
const ROLE_RANK: Record<UserRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function roleSatisfies(actual: UserRole, minimumRole: UserRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimumRole];
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export type AuthorizationOutcome = { ok: true; sessionId: string; user: AuthedUser } | { ok: false };

// The single function every admin route funnels through — deliberately
// framework-free (no cookies()/redirect()) so it is unit-testable and so
// requireAuth() below is a thin wrapper, not a second place the logic could
// drift out of sync. minimumRole is a required parameter: there is no
// "forgot to declare a role" path, and if a bad value ever reached
// ROLE_RANK, the missing lookup is `undefined`, and `actual >= undefined`
// is always false — the failure mode is deny, not allow.
export async function authorize(
  rawToken: string | undefined,
  minimumRole: UserRole,
  now: Date = new Date()
): Promise<AuthorizationOutcome> {
  if (!rawToken) {
    return { ok: false };
  }
  const resolved = await getSessionFromToken(rawToken, now);
  if (!resolved || !resolved.user.isActive) {
    return { ok: false };
  }
  if (!roleSatisfies(resolved.user.role, minimumRole)) {
    return { ok: false };
  }
  return {
    ok: true,
    sessionId: resolved.sessionId,
    user: { id: resolved.user.id, email: resolved.user.email, name: resolved.user.name, role: resolved.user.role },
  };
}

// Reads the httpOnly session cookie, resolves + authorizes it, and either
// returns the user or redirects to /admin/login. Every admin
// page/layout/server action must call this directly — hiding a nav link is
// UX, this is the actual gate.
export async function requireAuth(minimumRole: UserRole): Promise<AuthedUser> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const outcome = await authorize(rawToken, minimumRole);
  if (!outcome.ok) {
    redirect("/admin/login");
  }
  return outcome.user;
}
