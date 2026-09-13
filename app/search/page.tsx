import type { Metadata } from "next";
import { runVehicleSearch, type RawSearchParams } from "../../lib/services/search.service";
import { listLocations } from "../../lib/services/catalog.service";
import { formatMoney } from "../../lib/money";
import { SearchForm } from "../components/SearchForm";
import { selectVehicleAction } from "../actions/booking-flow";

// Date-bound results must never be indexed — the URL is only meaningful for
// the criteria it encodes at the moment it was generated.
export const metadata: Metadata = {
  title: "Search results | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const [outcome, locations] = await Promise.all([runVehicleSearch(raw), listLocations()]);

  if (!outcome.ok) {
    return (
      <main>
        <section className="section search-results-section">
          <div className="container">
            <div className="section-header">
              <div>
                <div className="eyebrow">
                  <span /> FIND A CAR
                </div>
                <h2>
                  Tell us <em>when and where.</em>
                </h2>
              </div>
            </div>
            <p className="section-intro" style={{ marginTop: 24 }}>
              {outcome.reason === "LOCATION_NOT_FOUND"
                ? "We couldn't find that pickup or drop-off location. Please choose one from the list."
                : "Pick a pickup location plus your pickup and return date and time to see available cars."}
            </p>
            <div style={{ marginTop: 40 }}>
              <SearchForm locations={locations} compact />
            </div>
          </div>
        </section>
      </main>
    );
  }

  const { criteria, vehicles } = outcome;
  const pickupLocation = locations.find((l) => l.id === criteria.pickupLocationId);
  const timeZone = pickupLocation?.timezone ?? "UTC";
  const notice = typeof raw.notice === "string" ? raw.notice : undefined;

  return (
    <main>
      <section className="section search-results-section">
        <div className="container">
          {notice === "unavailable" && (
            <p className="search-notice">
              That car was just booked by someone else. Here are the other cars still available for your dates.
            </p>
          )}
          {notice === "select-failed" && (
            <p className="search-notice">We couldn&apos;t start a booking for that car. Please try another one.</p>
          )}
          <div className="search-summary">
            <div className="search-summary-text">
              <span className="eyebrow">
                <span /> YOUR SEARCH
              </span>
              <h3>
                {criteria.pickupLocationName}
                {criteria.dropoffLocationName !== criteria.pickupLocationName
                  ? ` → ${criteria.dropoffLocationName}`
                  : ""}
              </h3>
              <p>
                {formatDateTime(criteria.pickupAt, timeZone)} — {formatDateTime(criteria.returnAt, timeZone)}
              </p>
            </div>
            <SearchForm
              locations={locations}
              compact
              defaults={{
                pickupLocationId: criteria.pickupLocationId,
                dropoffLocationId:
                  criteria.dropoffLocationId !== criteria.pickupLocationId ? criteria.dropoffLocationId : undefined,
              }}
            />
          </div>

          {vehicles.length === 0 ? (
            <div className="search-empty">
              <h3>No cars available for these dates</h3>
              <p>
                Nothing at {criteria.pickupLocationName} is free from {formatDateTime(criteria.pickupAt, timeZone)} to{" "}
                {formatDateTime(criteria.returnAt, timeZone)}. Try different dates or another location.
              </p>
            </div>
          ) : (
            <div className="fleet-grid search-results-grid">
              {vehicles.map((vehicle) => (
                <article className="fleet-card" key={vehicle.id}>
                  <div className="car-photo">
                    {vehicle.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={vehicle.imageUrl} alt={`${vehicle.make} ${vehicle.model}`} className="car-photo-image" />
                    ) : (
                      <div className="mini-car">
                        <i />
                        <b />
                        <u />
                      </div>
                    )}
                    <span className="fleet-tag">{vehicle.categoryName}</span>
                  </div>
                  <div className="fleet-details">
                    <div>
                      <h3>
                        {vehicle.make} {vehicle.model}
                      </h3>
                      <span>{vehicle.categoryName}</span>
                    </div>
                    <div className="price">
                      <strong>{formatMoney(vehicle.totalAmount, vehicle.currency)}</strong>
                      <small> total for this trip</small>
                    </div>
                  </div>
                  <div className="specs">
                    <span>◉ {vehicle.seats} seats</span>
                    <span>◌ {vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"}</span>
                    <span>⛽ {vehicle.fuelType}</span>
                  </div>
                  <div className="fleet-card-footer">
                    <span className="daily-rate">{formatMoney(vehicle.dailyRate, vehicle.currency)} / day</span>
                    <form action={selectVehicleAction}>
                      <input type="hidden" name="vehicleId" value={vehicle.id} />
                      <input type="hidden" name="pickupLocationId" value={criteria.pickupLocationId} />
                      <input type="hidden" name="dropoffLocationId" value={criteria.dropoffLocationId} />
                      <input type="hidden" name="pickupAt" value={criteria.pickupAt.toISOString()} />
                      <input type="hidden" name="returnAt" value={criteria.returnAt.toISOString()} />
                      <input type="hidden" name="pickupDate" value={String(raw.pickupDate ?? "")} />
                      <input type="hidden" name="pickupTime" value={String(raw.pickupTime ?? "")} />
                      <input type="hidden" name="returnDate" value={String(raw.returnDate ?? "")} />
                      <input type="hidden" name="returnTime" value={String(raw.returnTime ?? "")} />
                      <button className="outline-button" type="submit">
                        Select <span>↗</span>
                      </button>
                    </form>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
