import type { Metadata } from "next";
import { requireAuth } from "../../lib/auth/guard";
import { logoutAction } from "../actions/auth";

export const metadata: Metadata = {
  title: "Staff dashboard | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

// Behind requireAuth(), which reads the session cookie per request — never
// cached or frozen at build time.
export const dynamic = "force-dynamic";

// Placeholder proving the guard works — STAFF is the lowest role, so this
// route is reachable by every signed-in staff account. The real admin
// shell (nav, sections, feature screens) is P4-P2.
export default async function AdminHomePage() {
  const user = await requireAuth("STAFF");

  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          <div className="eyebrow">
            <span /> STAFF AREA
          </div>
          <h3>
            Signed in as {user.name} <em>({user.role})</em>
          </h3>
          <form action={logoutAction}>
            <button type="submit" className="outline-button">
              Log out
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
