import type { Metadata } from "next";
import Link from "next/link";
import { getQuote } from "../../../lib/services/quote.service";
import { getLocationById } from "../../../lib/services/catalog.service";
import { formatMoney } from "../../../lib/money";
import { BookingWizard, type BookingWizardData } from "../../components/BookingWizard";

export const metadata: Metadata = {
  title: "Complete your booking | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

function ExpiredOrMissing({ heading, body }: { heading: string; body: string }) {
  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          <div className="search-empty">
            <h3>{heading}</h3>
            <p>{body}</p>
            <Link href="/search" className="text-link">
              Back to search <span>↗</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ quoteId: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const { quoteId } = await params;
  const { step: rawStep } = await searchParams;

  const record = await getQuote(quoteId);
  if (!record) {
    return (
      <ExpiredOrMissing
        heading="We couldn't find that booking"
        body="This link may be wrong or the quote no longer exists. Start a new search to find a car."
      />
    );
  }

  // An expired hold must never reach submission — this state overrides
  // whatever step is in the URL, at every step.
  if (record.isExpired) {
    return (
      <ExpiredOrMissing
        heading="This hold has expired"
        body="We can only hold a car for a short time. Please search again to find and hold a car."
      />
    );
  }

  const { quote } = record;
  const [pickupLocation, dropoffLocation] = await Promise.all([
    getLocationById(quote.pickupLocationId),
    getLocationById(quote.dropoffLocationId),
  ]);

  const step = Number(rawStep);
  const initialStep = [1, 2, 3, 4].includes(step) ? step : 1;

  const data: BookingWizardData = {
    quoteId: quote.id,
    expiresAt: quote.expiresAt.toISOString(),
    vehicle: {
      make: quote.vehicle.model.make,
      model: quote.vehicle.model.model,
      categoryName: quote.vehicle.model.category.name,
      seats: quote.vehicle.model.seats,
      transmission: quote.vehicle.model.transmission,
      fuelType: quote.vehicle.model.fuelType,
      imageUrl: quote.vehicle.images[0]?.url ?? null,
      minDriverAge: quote.vehicle.minDriverAge,
    },
    pickupLocationName: pickupLocation?.name ?? "Pickup location",
    dropoffLocationName: dropoffLocation?.name ?? "Drop-off location",
    pickupAt: quote.pickupAt.toISOString(),
    returnAt: quote.returnAt.toISOString(),
    rentalDays: quote.rentalDays,
    currency: quote.currency,
    priced: {
      lineItems: quote.lineItems.map((li) => ({
        description: li.description,
        amount: formatMoney(li.totalAmount, quote.currency),
      })),
      subtotal: formatMoney(quote.subtotalAmount, quote.currency),
      tax: formatMoney(quote.taxAmount, quote.currency),
      total: formatMoney(quote.totalAmount, quote.currency),
      deposit: formatMoney(quote.securityDeposit, quote.currency),
    },
  };

  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          <BookingWizard data={data} initialStep={initialStep} />
        </div>
      </section>
    </main>
  );
}
