import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Terms & conditions (draft) | Amihan Car Rentals",
  description: "Draft rental terms and conditions, pending legal review.",
};

export default function TermsPage() {
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
          <h2>Terms &amp; conditions</h2>
          <p>
            This is a working outline of the topics our rental agreement will cover, not a finished legal document.
            Nothing on this page should be relied on as binding until it has been reviewed and published by counsel.
          </p>

          <h3>Topics to be covered</h3>
          <ul>
            <li>Eligibility (driver age, licence validity) and required documents at pickup</li>
            <li>Booking, quote holds, and cancellation terms</li>
            <li>Pricing, taxes, and the security deposit — how it&apos;s charged and refunded</li>
            <li>Mileage allowances and extra-kilometre charges where applicable</li>
            <li>Vehicle condition, damage, and liability at pickup and return</li>
            <li>Late returns and the billing grace period</li>
            <li>One-way / cross-location drop-off terms, where offered</li>
            <li>Prohibited uses and consequences of misuse</li>
            <li>Governing law and dispute resolution</li>
          </ul>

          <h3>Status</h3>
          <p>Owner sign-off and legal review are required before this page is finalised for launch.</p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
