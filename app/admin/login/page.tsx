import type { Metadata } from "next";
import { loginAction } from "../../actions/auth";

export const metadata: Metadata = {
  title: "Staff sign in | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

// Reads the session cookie itself (via requireAuth downstream) per request —
// never cached or frozen at build time.
export const dynamic = "force-dynamic";

const GENERIC_ERROR = "Incorrect email or password.";
const LOCKED_ERROR = "Too many failed attempts. Try again in 15 minutes.";

export default async function StaffLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error === "locked" ? LOCKED_ERROR : error === "invalid" ? GENERIC_ERROR : null;

  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          <div className="booking-wizard" style={{ maxWidth: 420 }}>
            <div className="eyebrow">
              <span /> STAFF ACCESS
            </div>
            <h3>Sign in</h3>

            {errorMessage && <p className="booking-error">{errorMessage}</p>}

            <form className="booking-form" action={loginAction}>
              <label>
                Email
                <input type="email" name="email" autoComplete="username" required />
              </label>
              <label>
                Password
                <input type="password" name="password" autoComplete="current-password" required />
              </label>
              <button type="submit" className="dark-button">
                Sign in <span>&rarr;</span>
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
