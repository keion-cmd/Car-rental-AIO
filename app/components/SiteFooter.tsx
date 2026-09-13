import Link from "next/link";

const COMPANY_LINKS = [
  { href: "/#fleet", label: "Fleet" },
  { href: "/#locations", label: "Locations" },
  { href: "/#how-it-works", label: "About us" },
  { href: "/contact", label: "Contact" },
];

const LEGAL_LINKS = [
  { href: "/rental-requirements", label: "Rental requirements" },
  { href: "/faq", label: "FAQ" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cancellation-policy", label: "Cancellation policy" },
];

export function SiteFooter() {
  return (
    <footer>
      <div className="container footer-top">
        <Link className="brand footer-brand" href="/">
          <span className="brand-mark">A</span>
          <span>
            <strong>amihan</strong>
            <small>CAR RENTALS</small>
          </span>
        </Link>
        <div className="footer-quote">
          Take the scenic route.
          <br />
          <em>We&apos;ll handle the rest.</em>
        </div>
        <div className="footer-links-columns">
          <div className="footer-links">
            {COMPANY_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
          <div className="footer-links">
            {LEGAL_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 Amihan Car Rentals</span>
        <span>
          Made for the road ahead in the Philippines <b>✦</b>
        </span>
      </div>
    </footer>
  );
}
