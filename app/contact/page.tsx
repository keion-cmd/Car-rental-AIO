import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "Contact | Amihan Car Rentals",
  description: "Address, phone, and email for Amihan Car Rentals.",
};

export default function ContactPage() {
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
            <span /> GET IN TOUCH
          </div>
          <h2>Contact us</h2>
          <p>Reach us directly — we don&apos;t run a contact form on this site.</p>

          <div className="contact-cards">
            <div className="contact-card">
              <h3>Address</h3>
              <p>
                [Placeholder — branch address]
                <br />
                Manila, Philippines
              </p>
            </div>
            <div className="contact-card">
              <h3>Phone</h3>
              <p>
                <a href="tel:+63285550188">(02) 8555 0188</a>
                <br />
                7 days a week
              </p>
            </div>
            <div className="contact-card">
              <h3>Email</h3>
              <p>
                <a href="mailto:hello@amihancars.ph">hello@amihancars.ph</a>
              </p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
