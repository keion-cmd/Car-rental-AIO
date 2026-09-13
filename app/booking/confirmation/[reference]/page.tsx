import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBookingByReference } from "../../../../lib/services/booking.service";
import { getLocationById } from "../../../../lib/services/catalog.service";
import { formatMoney } from "../../../../lib/money";

export const metadata: Metadata = {
  title: "Booking confirmed | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default async function BookingConfirmationPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const booking = await getBookingByReference(reference);
  if (!booking) {
    notFound();
  }

  const pickupLocation = await getLocationById(booking.pickupLocationId);

  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          <div className="booking-confirmation">
            <span className="eyebrow">
              <span /> BOOKING CONFIRMED
            </span>
            <h2>
              Reference <em>{booking.reference}</em>
            </h2>
            <p className="section-intro" style={{ maxWidth: 520 }}>
              Your {booking.vehicle.model.make} {booking.vehicle.model.model} is reserved. Pay at the counter when
              you pick up the car — no payment was collected online.
            </p>

            <div className="booking-confirmation-grid">
              <div>
                <h4>What happens next</h4>
                <p>
                  Bring the ID and licence used to book, plus the card for the refundable security deposit. Staff
                  will confirm your reservation using this reference.
                </p>

                <h4>Pickup location</h4>
                <p>
                  {pickupLocation?.name ?? "Pickup location"}
                  <br />
                  {formatDateTime(booking.pickupAt)}
                </p>

                <h4>What to bring</h4>
                <p>Driver&apos;s licence, a valid government ID, and the deposit card.</p>

                <h4>Cancellation terms</h4>
                <p>Free cancellation up to 24 hours before pickup. The deposit is refunded after a damage-free return.</p>
              </div>

              <aside className="booking-summary">
                <h4>Price summary</h4>
                <ul className="booking-summary-lines">
                  {booking.lineItems.map((li) => (
                    <li key={li.id}>
                      <span>{li.description}</span>
                      <span>{formatMoney(li.totalAmount, booking.currency)}</span>
                    </li>
                  ))}
                </ul>
                <div className="booking-summary-row">
                  <span>Subtotal</span>
                  <span>{formatMoney(booking.subtotalAmount, booking.currency)}</span>
                </div>
                <div className="booking-summary-row">
                  <span>Tax</span>
                  <span>{formatMoney(booking.taxAmount, booking.currency)}</span>
                </div>
                <div className="booking-summary-row booking-summary-total">
                  <span>Total</span>
                  <span>{formatMoney(booking.totalAmount, booking.currency)}</span>
                </div>
                <div className="booking-summary-deposit">
                  <span>Security deposit (refundable, not included in total)</span>
                  <span>{formatMoney(booking.securityDeposit, booking.currency)}</span>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
