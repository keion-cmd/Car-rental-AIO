import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Privacy policy (draft) | Amihan Car Rentals",
  description: "Draft privacy policy, pending legal review.",
};

export default function PrivacyPage() {
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
          <h2>Privacy policy</h2>
          <p>
            This is a working outline of the topics our privacy policy will cover, not a finished legal document.
            Nothing on this page should be relied on as an accurate description of our data practices until it has
            been reviewed and published by counsel.
          </p>

          <h3>Topics to be covered</h3>
          <ul>
            <li>What personal and driver-licence information is collected during booking, and why</li>
            <li>How booking, payment, and identity data is stored and encrypted</li>
            <li>Notification emails and how booking confirmations are sent</li>
            <li>Data retention periods for bookings, quotes, and customer records</li>
            <li>Any third parties data is shared with (payment, notifications, hosting)</li>
            <li>How customers can request access to or deletion of their data</li>
            <li>Cookie and analytics usage on the booking site, if any</li>
          </ul>

          <h3>Status</h3>
          <p>Owner sign-off and legal review are required before this page is finalised for launch.</p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
