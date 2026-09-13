import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { Card } from "../../../components/admin/Card";
import { listLocations } from "../../../../lib/services/catalog.service";
import { listVehicleCategories } from "../../../../lib/services/fleet.service";
import { createVehicleAction } from "../../../actions/fleet";

export const metadata: Metadata = {
  title: "Add vehicle | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  "invalid-input": "Enter a valid daily rate, security deposit and seat count.",
};

export default async function NewVehiclePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAuth("MANAGER");
  const raw = await searchParams;
  const errorFlag = Array.isArray(raw.error) ? raw.error[0] : raw.error;

  const [categories, locations] = await Promise.all([listVehicleCategories(), listLocations()]);

  return (
    <>
      <PageHeader
        title="Add vehicle"
        description="Creates the vehicle, reusing a matching model/spec if one already exists in this category."
        action={<Link href="/admin/fleet" className="outline-button">← Back to fleet</Link>}
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
        </div>
      )}

      <Card>
        <form action={createVehicleAction}>
          <div className="admin-field">
            <label htmlFor="plateNumber">Plate number</label>
            <input id="plateNumber" name="plateNumber" required />
          </div>

          <h3>Spec</h3>
          <div className="admin-field">
            <label htmlFor="categoryId">Category</label>
            <select id="categoryId" name="categoryId" required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="make">Make</label>
            <input id="make" name="make" required />
          </div>
          <div className="admin-field">
            <label htmlFor="model">Model</label>
            <input id="model" name="model" required />
          </div>
          <div className="admin-field">
            <label htmlFor="seats">Seats</label>
            <input id="seats" name="seats" type="number" min={1} required />
          </div>
          <div className="admin-field">
            <label htmlFor="transmission">Transmission</label>
            <select id="transmission" name="transmission" required>
              <option value="AUTOMATIC">Automatic</option>
              <option value="MANUAL">Manual</option>
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="fuelType">Fuel type</label>
            <select id="fuelType" name="fuelType" required>
              <option value="PETROL">Petrol</option>
              <option value="DIESEL">Diesel</option>
              <option value="HYBRID">Hybrid</option>
              <option value="ELECTRIC">Electric</option>
            </select>
          </div>

          <h3>Location</h3>
          <div className="admin-field">
            <label htmlFor="homeLocationId">Home location</label>
            <select id="homeLocationId" name="homeLocationId" required>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="currentLocationId">Current location (defaults to home)</label>
            <select id="currentLocationId" name="currentLocationId">
              <option value="">Same as home</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <h3>Pricing</h3>
          <div className="admin-field">
            <label htmlFor="dailyRate">Daily rate</label>
            <input id="dailyRate" name="dailyRate" placeholder="e.g. 1500.00" required />
          </div>
          <div className="admin-field">
            <label htmlFor="securityDeposit">Security deposit</label>
            <input id="securityDeposit" name="securityDeposit" placeholder="e.g. 5000.00" />
          </div>
          <div className="admin-field">
            <label htmlFor="minDriverAge">Minimum driver age</label>
            <input id="minDriverAge" name="minDriverAge" type="number" min={16} defaultValue={21} />
          </div>
          <div className="admin-field">
            <label htmlFor="minRentalDays">Minimum rental days</label>
            <input id="minRentalDays" name="minRentalDays" type="number" min={1} defaultValue={1} />
          </div>

          <button type="submit" className="admin-primary-button">Create vehicle</button>
        </form>
      </Card>
    </>
  );
}
