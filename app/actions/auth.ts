"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, logout } from "../../lib/services/auth.service";
import { getSessionFromToken } from "../../lib/auth/session";
import { SESSION_COOKIE_NAME } from "../../lib/auth/guard";

// A real <form> POST, same philosophy as the booking flow's
// selectVehicleAction — works without client JS. The failure reason
// travels back as a query-string flag, not as returned text, so the two
// INVALID_CREDENTIALS causes (unknown email, wrong password) render through
// the exact same "invalid" branch on the login page and are visually
// indistinguishable. ACCOUNT_LOCKED gets its own flag — that isn't leaking
// which credential was wrong, it's telling an already-identified account
// holder to stop guessing and wait.
export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const outcome = await login(email, password);

  if (!outcome.ok) {
    redirect(`/admin/login?error=${outcome.reason === "ACCOUNT_LOCKED" ? "locked" : "invalid"}`);
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, outcome.rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: outcome.expiresAt,
  });

  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    const resolved = await getSessionFromToken(rawToken);
    if (resolved) {
      await logout(resolved.sessionId);
    }
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect("/admin/login");
}
