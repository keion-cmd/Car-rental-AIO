import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "../components/SiteFooter";

export const metadata: Metadata = {
  title: "FAQ | Amihan Car Rentals",
  description: "Answers to common questions about booking, holds, cancellation, deposits, mileage, and pickup.",
};

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "How does booking work?",
    a: "Search by location and dates, pick a vehicle, and complete a short checkout with your details and driver's licence. You'll get a booking reference and a confirmation page — payment is collected at the counter, not online.",
  },
  {
    q: "What is a quote hold?",
    a: "When you start checkout, we place a temporary hold on the vehicle for your requested dates so someone else can't book it out from under you while you finish. Holds expire if checkout isn't completed in time, releasing the vehicle back to availability.",
  },
  {
    q: "Can I cancel my booking?",
    a: "Yes — cancellation is free up to 24 hours before pickup. See the Cancellation policy page for details.",
  },
  {
    q: "Is the security deposit refundable?",
    a: "Yes. The deposit is charged (or held) at pickup and refunded after the vehicle is returned undamaged. Deposit amounts vary by vehicle — see Rental requirements for current ranges.",
  },
  {
    q: "Is mileage included?",
    a: "Some vehicles include a set amount of kilometres per day, with an extra-kilometre rate beyond that; others don't cap mileage. This is set per vehicle, so check the specific listing you're booking.",
  },
  {
    q: "What do I need to bring at pickup?",
    a: "A valid driver's licence, a valid government-issued ID, and the card used to secure the deposit.",
  },
  {
    q: "Can I pick up in one city and drop off in another?",
    a: "One-way rentals are supported between some location pairs, sometimes with a transfer fee or a minimum notice window; other pairs aren't allowed. This is configured per route, so confirm your specific pickup and drop-off locations when booking.",
  },
  {
    q: "Is there a minimum age to rent?",
    a: "Yes. Minimum driver age varies by vehicle, and drivers under a certain age may be charged a young-driver surcharge. See Rental requirements for the current figures.",
  },
  {
    q: "What happens if I return the car late?",
    a: "There's a short grace period after your scheduled return time before an extra day is billed — see Rental requirements for the exact window.",
  },
  {
    q: "How will I know my booking is confirmed?",
    a: "After checkout you'll land on a confirmation page showing your booking reference, pickup details, and price summary. Keep the reference handy for pickup.",
  },
];

export default function FaqPage() {
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
            <span /> QUESTIONS
          </div>
          <h2>Frequently asked questions</h2>
          <p>Straight answers about how booking, holds, and pickup actually work.</p>

          {FAQS.map((item) => (
            <div className="faq-item" key={item.q}>
              <h3>{item.q}</h3>
              <p>{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
