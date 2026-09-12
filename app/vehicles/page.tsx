import type { Metadata } from "next";
import Link from "next/link";
import { listBrowsableVehiclesByCategory, getCurrency } from "../../lib/services/catalog.service";
import { formatMoney } from "../../lib/money";

// No dates required, so this page is indexable — unlike /search, which is
// date-bound.
export const metadata: Metadata = {
  title: "Our fleet | Amihan Car Rentals",
  description: "Browse every car in the Amihan Car Rentals fleet, grouped by category.",
};

export default async function VehiclesPage() {
  const [categories, currency] = await Promise.all([listBrowsableVehiclesByCategory(), getCurrency()]);

  return (
    <main>
      <section className="section fleet-section">
        <div className="container">
          <div className="section-header">
            <div>
              <div className="eyebrow">
                <span /> OUR FLEET
              </div>
              <h2>
                Every car,<br />
                <em>ready to book.</em>
              </h2>
            </div>
            <div className="section-intro">
              <p>Pick a category below, then search your dates to see real availability and pricing.</p>
              <Link href="/#search" className="text-link">
                Search dates <span>↗</span>
              </Link>
            </div>
          </div>

          {categories.length === 0 ? (
            <p className="section-intro" style={{ marginTop: 40 }}>
              No vehicles are currently bookable online.
            </p>
          ) : (
            categories.map((category) => (
              <div className="fleet-category" key={category.id}>
                <h3 className="fleet-category-title">{category.name}</h3>
                <div className="fleet-grid">
                  {category.vehicles.map((vehicle) => (
                    <article className="fleet-card" key={vehicle.id}>
                      <div className="car-photo">
                        {vehicle.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={vehicle.imageUrl}
                            alt={`${vehicle.make} ${vehicle.model}`}
                            className="car-photo-image"
                          />
                        ) : (
                          <div className="mini-car">
                            <i />
                            <b />
                            <u />
                          </div>
                        )}
                        <span className="fleet-tag">{category.name}</span>
                      </div>
                      <div className="fleet-details">
                        <div>
                          <h3>
                            {vehicle.make} {vehicle.model}
                          </h3>
                          <span>{category.name}</span>
                        </div>
                        <div className="price">
                          <strong>{formatMoney(vehicle.dailyRate, currency)}</strong>
                          <small> / day</small>
                        </div>
                      </div>
                      <div className="specs">
                        <span>◉ {vehicle.seats} seats</span>
                        <span>◌ {vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"}</span>
                        <span>⛽ {vehicle.fuelType}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
