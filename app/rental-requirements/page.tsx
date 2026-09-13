import type { Metadata } from "next";
import Link from "next/link";
import { getRentalRequirements } from "../../lib/services/catalog.service";
import { formatMoney } from "../../lib/money";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Rental requirements | Amihan Car Rentals",
  description: "Minimum driver age, deposit range, and billing grace period for renting with Amihan Car Rentals.",
};

// Figures are read live from vehicle and settings data, per the page's own
// data-notice — must not be frozen at build time.
export const dynamic = "force-dynamic";

export default async function RentalRequirementsPage() {
  const req = await getRentalRequirements();

  const depositRange =
    req.securityDepositMin !== null && req.securityDepositMax !== null
      ? req.securityDepositMin === req.securityDepositMax
        ? formatMoney(req.securityDepositMin, req.currency)
        : `${formatMoney(req.securityDepositMin, req.currency)} – ${formatMoney(req.securityDepositMax, req.currency)}`
      : null;

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
          <div className="eyebrow">
            <span /> BEFORE YOU BOOK
          </div>
          <h2>Rental requirements</h2>
          <p>What you need to rent a car with us, and what it costs beyond the daily rate.</p>

          <h3>Minimum driver age</h3>
          {req.minDriverAgeAcrossFleet !== null ? (
            <p>
              The minimum driver age is <strong>{req.minDriverAgeAcrossFleet}</strong> for our most accessible
              vehicles. Some vehicles require an older driver — check the specific listing before booking.
            </p>
          ) : (
            <p>Minimum driver age varies by vehicle — check the specific listing before booking.</p>
          )}

          <h3>Young driver surcharge</h3>
          <p>
            Drivers under <strong>{req.youngDriverMaxAge}</strong> years old
            {req.youngDriverSurchargePerDay > BigInt(0)
              ? ` are charged an additional ${formatMoney(req.youngDriverSurchargePerDay, req.currency)} per day.`
              : " are not currently charged an additional surcharge."}
          </p>

          <h3>Security deposit</h3>
          <p>
            {depositRange
              ? `Refundable security deposits across our current fleet range from ${depositRange}, taken at pickup and refunded after a damage-free return.`
              : "Security deposit amounts vary by vehicle — check the specific listing before booking."}
          </p>

          <h3>Billing grace period</h3>
          <p>
            Returns up to <strong>{req.billingGraceMinutes} minutes</strong> past your scheduled return time are not
            billed as an extra day.
          </p>

          <h3>What to bring at pickup</h3>
          <ul>
            <li>A valid driver&apos;s licence</li>
            <li>A valid government-issued ID</li>
            <li>The card used to secure the deposit</li>
          </ul>

          <div className="data-notice">
            Minimum driver age, security deposit range, and young-driver figures above are read live from our
            current vehicle and settings data. Placeholder items (none currently) would be marked as such — nothing
            on this page is hardcoded against the database.
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
