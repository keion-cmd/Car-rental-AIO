import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Cancellation policy (draft) | Amihan Car Rentals",
  description: "Draft cancellation policy, pending legal review.",
};

export default function CancellationPolicyPage() {
  return (
    <main>
      <nav className="simple-nav container">
        <Link className="brand" href="/" aria-label="Amihan Cars home">
          <span className="brand-mark">A</span>
          <span>
            <strong>amihan</strong>
            <small>CAR RENTALS</small>
          </span>
        </Link>
      </nav>

      <section className="section search-results-section">
        <div className="container legal-page">
          <div className="draft-notice">Draft — pending legal review. Not binding.</div>

          <div className="eyebrow">
            <span /> LEGAL
          </div>
          <h2>Cancellation policy</h2>
          <p>
            This page states the cancellation rule as it operates in the booking flow today. The wording is still a
            draft and has not been reviewed by counsel — treat it as a description of current behaviour, not a
            finished legal document.
          </p>

          <h3>Current rule</h3>
          <p>
            Cancellation is free up to 24 hours before your scheduled pickup time. The refundable security deposit
            is returned after the vehicle is checked in and confirmed returned without damage.
          </p>

          <h3>Topics still to be covered</h3>
          <ul>
            <li>What happens to cancellations made inside the 24-hour window</li>
            <li>No-show handling if a booking isn&apos;t picked up at all</li>
            <li>How a cancelled booking&apos;s quote hold and vehicle block are released</li>
            <li>Refund timing and method for any amounts already collected</li>
            <li>Cancellations initiated by us (e.g. vehicle unavailability)</li>
          </ul>

          <h3>Status</h3>
          <p>Owner sign-off and legal review are required before this page is finalised for launch.</p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
