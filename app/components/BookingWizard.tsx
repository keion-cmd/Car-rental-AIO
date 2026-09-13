"use client";

import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  repriceStepTwoAction,
  submitBookingAction,
  type FormattedPriced,
} from "../actions/booking-flow";

export interface BookingWizardData {
  quoteId: string;
  expiresAt: string;
  vehicle: {
    make: string;
    model: string;
    categoryName: string;
    seats: number;
    transmission: "MANUAL" | "AUTOMATIC";
    fuelType: string;
    imageUrl: string | null;
    minDriverAge: number;
  };
  pickupLocationName: string;
  dropoffLocationName: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  currency: string;
  priced: FormattedPriced;
}

// Reason codes are the service layer's, never re-derived here — this map
// only supplies display copy for codes that already exist in
// lib/pricing/quote.ts, lib/services/quote.service.ts, and
// lib/validation/booking.ts.
const REASON_MESSAGES: Record<string, string> = {
  QUOTE_NOT_FOUND: "We couldn't find this booking. Please start a new search.",
  QUOTE_EXPIRED: "This hold has expired. Please start a new search.",
  VEHICLE_UNAVAILABLE: "This car was just booked by someone else.",
  VEHICLE_NOT_FOUND: "This car is no longer available.",
  VEHICLE_NOT_PRICED: "This car isn't available for online booking right now.",
  INVALID_DATE_RANGE: "The pickup and return dates are no longer valid.",
  BELOW_MIN_RENTAL_DAYS: "This car requires a longer minimum rental.",
  ABOVE_MAX_RENTAL_DAYS: "This car can't be booked for this many days.",
  ONE_WAY_NOT_ALLOWED: "One-way drop-off isn't allowed for this route.",
  PRICE_UNAVAILABLE: "We couldn't price this car right now.",
  VALIDATION_ERROR: "Please check the details you entered and try again.",
  LICENCE_EXPIRED: "This licence has already expired.",
  LICENCE_EXPIRES_DURING_RENTAL: "This licence expires before the return date.",
};

function reasonMessage(reason: string, minDriverAge: number): string {
  if (reason === "DRIVER_UNDER_AGE") {
    return `The driver must be at least ${minDriverAge} years old to rent this car.`;
  }
  return REASON_MESSAGES[reason] ?? "Something went wrong. Please try again.";
}

function maskLicence(value: string): string {
  if (value.length <= 3) return "•".repeat(value.length);
  return "•".repeat(value.length - 3) + value.slice(-3);
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "expired";
  const totalMinutes = Math.floor(msRemaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((msRemaining % 60_000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

interface DriverFields {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  licenceNumber: string;
  licenceCountry: string;
  licenceExpiry: string;
}

const EMPTY_DRIVER: DriverFields = {
  fullName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  licenceNumber: "",
  licenceCountry: "",
  licenceExpiry: "",
};

function PriceSummary({ priced, label }: { priced: FormattedPriced; label?: string }) {
  return (
    <aside className="booking-summary">
      {label && <h4>{label}</h4>}
      <ul className="booking-summary-lines">
        {priced.lineItems.map((li, i) => (
          <li key={i}>
            <span>{li.description}</span>
            <span>{li.amount}</span>
          </li>
        ))}
      </ul>
      <div className="booking-summary-row">
        <span>Subtotal</span>
        <span>{priced.subtotal}</span>
      </div>
      <div className="booking-summary-row">
        <span>Tax</span>
        <span>{priced.tax}</span>
      </div>
      <div className="booking-summary-row booking-summary-total">
        <span>Total</span>
        <span>{priced.total}</span>
      </div>
      <div className="booking-summary-deposit">
        <span>Security deposit (refundable, not included in total)</span>
        <span>{priced.deposit}</span>
      </div>
    </aside>
  );
}

export function BookingWizard({ data, initialStep }: { data: BookingWizardData; initialStep: number }) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [driver, setDriver] = useState<DriverFields>(EMPTY_DRIVER);
  const [priced, setPriced] = useState<FormattedPriced>(data.priced);
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const expiresAtMs = useMemo(() => new Date(data.expiresAt).getTime(), [data.expiresAt]);
  const msRemaining = expiresAtMs - now;
  const isExpired = msRemaining <= 0;

  function goToStep(next: number) {
    setError(null);
    setStep(next);
    router.replace(`/book/${data.quoteId}?step=${next}`, { scroll: false });
  }

  function handleStepTwoSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await repriceStepTwoAction({
        quoteId: data.quoteId,
        driverDateOfBirth: driver.dateOfBirth,
        driverLicenceExpiry: driver.licenceExpiry,
      });
      if (!result.ok) {
        setError(reasonMessage(result.reason, data.vehicle.minDriverAge));
        return;
      }
      setPriced(result.priced);
      goToStep(3);
    });
  }

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await submitBookingAction({
        quoteId: data.quoteId,
        driverFullName: driver.fullName,
        driverEmail: driver.email,
        driverPhone: driver.phone,
        driverDateOfBirth: driver.dateOfBirth,
        driverLicenceNumber: driver.licenceNumber,
        driverLicenceCountry: driver.licenceCountry.toUpperCase(),
        driverLicenceExpiry: driver.licenceExpiry,
      });
      // On success submitBookingAction redirects server-side and this line
      // is never reached; only a rejection returns here.
      setError(reasonMessage(result.reason, data.vehicle.minDriverAge));
    });
  }

  if (isExpired) {
    return (
      <div className="search-empty">
        <h3>This hold has expired</h3>
        <p>We can only hold a car for a short time. Please search again to find and hold a car.</p>
        <a href="/search" className="text-link">
          Back to search <span>↗</span>
        </a>
      </div>
    );
  }

  return (
    <div className="booking-wizard">
      <div className="booking-steps">
        {["Review", "Driver details", "Confirm", "Submit"].map((label, i) => (
          <span key={label} className={i + 1 === step ? "booking-step active" : "booking-step"}>
            {i + 1}. {label}
          </span>
        ))}
        <span className="booking-hold-timer">{formatCountdown(msRemaining)}</span>
      </div>

      <div className="booking-wizard-body">
        <div className="booking-wizard-main">
          {step === 1 && (
            <section>
              <h3>
                {data.vehicle.make} {data.vehicle.model}
              </h3>
              <p className="section-intro">
                {data.vehicle.categoryName} · {data.vehicle.seats} seats ·{" "}
                {data.vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"} · {data.vehicle.fuelType}
              </p>
              <ul className="booking-review-list">
                <li>
                  <span>Pickup</span>
                  <span>
                    {data.pickupLocationName} — {formatDateTime(data.pickupAt)}
                  </span>
                </li>
                <li>
                  <span>Return</span>
                  <span>
                    {data.dropoffLocationName} — {formatDateTime(data.returnAt)}
                  </span>
                </li>
                <li>
                  <span>Duration</span>
                  <span>{data.rentalDays} day(s)</span>
                </li>
              </ul>
              <button className="dark-button" type="button" onClick={() => goToStep(2)}>
                Continue <span>→</span>
              </button>
            </section>
          )}

          {step === 2 && (
            <section>
              <h3>Driver details</h3>
              <form className="booking-form" onSubmit={handleStepTwoSubmit}>
                <label>
                  Full name
                  <input
                    required
                    value={driver.fullName}
                    onChange={(e) => setDriver({ ...driver, fullName: e.target.value })}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={driver.email}
                    onChange={(e) => setDriver({ ...driver, email: e.target.value })}
                  />
                </label>
                <label>
                  Phone
                  <input
                    required
                    value={driver.phone}
                    onChange={(e) => setDriver({ ...driver, phone: e.target.value })}
                  />
                </label>
                <label>
                  Date of birth
                  <input
                    type="date"
                    required
                    value={driver.dateOfBirth}
                    onChange={(e) => setDriver({ ...driver, dateOfBirth: e.target.value })}
                  />
                </label>
                <label>
                  Licence number
                  <input
                    required
                    value={driver.licenceNumber}
                    onChange={(e) => setDriver({ ...driver, licenceNumber: e.target.value })}
                  />
                </label>
                <label>
                  Licence issuing country (2-letter)
                  <input
                    required
                    maxLength={2}
                    style={{ textTransform: "uppercase" }}
                    value={driver.licenceCountry}
                    onChange={(e) => setDriver({ ...driver, licenceCountry: e.target.value })}
                  />
                </label>
                <label>
                  Licence expiry
                  <input
                    type="date"
                    required
                    value={driver.licenceExpiry}
                    onChange={(e) => setDriver({ ...driver, licenceExpiry: e.target.value })}
                  />
                </label>
                {error && <p className="booking-error">{error}</p>}
                <button className="dark-button" type="submit" disabled={isPending}>
                  {isPending ? "Checking…" : "Continue"} <span>→</span>
                </button>
              </form>
            </section>
          )}

          {step === 3 && (
            <section>
              <h3>Confirm your booking</h3>
              <ul className="booking-review-list">
                <li>
                  <span>Driver</span>
                  <span>{driver.fullName}</span>
                </li>
                <li>
                  <span>Email</span>
                  <span>{driver.email}</span>
                </li>
                <li>
                  <span>Phone</span>
                  <span>{driver.phone}</span>
                </li>
                <li>
                  <span>Licence</span>
                  <span>
                    {driver.licenceCountry.toUpperCase()} · {maskLicence(driver.licenceNumber)}
                  </span>
                </li>
              </ul>
              <div className="booking-terms">
                <h4>What to bring at pickup</h4>
                <p>Your driver&apos;s licence, a valid ID, and the card used to secure the deposit.</p>
                <h4>Cancellation terms</h4>
                <p>Free cancellation up to 24 hours before pickup. The security deposit is refunded after the vehicle is returned undamaged.</p>
              </div>
              <label className="booking-terms-check">
                <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
                I agree to the <a href="/terms" target="_blank" rel="noopener noreferrer">rental terms</a> and{" "}
                <a href="/cancellation-policy" target="_blank" rel="noopener noreferrer">cancellation policy</a>.
              </label>
              {error && <p className="booking-error">{error}</p>}
              <button className="dark-button" type="button" disabled={!termsAccepted} onClick={() => goToStep(4)}>
                Continue <span>→</span>
              </button>
            </section>
          )}

          {step === 4 && (
            <section>
              <h3>Submit your booking</h3>
              <p className="section-intro">
                This reserves the car now, paid at the counter. No payment is collected online.
              </p>
              {error && <p className="booking-error">{error}</p>}
              <button className="dark-button" type="button" disabled={isPending} onClick={handleSubmit}>
                {isPending ? "Submitting…" : "Confirm booking"} <span>→</span>
              </button>
            </section>
          )}
        </div>

        <PriceSummary priced={priced} label="Price summary" />
      </div>
    </div>
  );
}
