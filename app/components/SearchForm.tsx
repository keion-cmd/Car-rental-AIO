"use client";

import { useId, useState } from "react";

export interface SearchFormLocation {
  id: string;
  name: string;
}

export interface SearchFormDefaults {
  pickupLocationId?: string;
  dropoffLocationId?: string;
  pickupDate?: string;
  pickupTime?: string;
  returnDate?: string;
  returnTime?: string;
}

const TIME_OPTIONS = [
  { value: "10:00", label: "10:00 AM" },
  { value: "12:00", label: "12:00 PM" },
  { value: "14:00", label: "02:00 PM" },
  { value: "16:00", label: "04:00 PM" },
];

// Renders a real GET form targeting /search — the browser builds the query
// string itself, so navigation, refresh, and back-navigation all work with
// no client-side fetch or router call. The only client-side state is the
// "return to a different location" disclosure toggle.
export function SearchForm({
  locations,
  defaults,
  compact = false,
}: {
  locations: SearchFormLocation[];
  defaults?: SearchFormDefaults;
  compact?: boolean;
}) {
  const formId = useId();
  const [pickupLocationId, setPickupLocationId] = useState(defaults?.pickupLocationId ?? locations[0]?.id ?? "");
  const [differentReturn, setDifferentReturn] = useState(
    Boolean(defaults?.dropoffLocationId && defaults.dropoffLocationId !== defaults?.pickupLocationId)
  );

  const otherLocations = locations.filter((l) => l.id !== pickupLocationId);

  return (
    <div className={compact ? "search-card search-card-compact" : "search-card"} id={compact ? undefined : "search"}>
      {!compact && (
        <div className="search-heading">
          <span className="step-number">01</span>
          <div>
            <strong>Find your ride</strong>
            <small>Tell us when and where</small>
          </div>
        </div>
      )}
      <form id={formId} action="/search" method="GET">
        <label className="field location-field">
          <span className="field-icon">⌖</span>
          <span className="field-label">PICKUP LOCATION</span>
          <select
            name="pickupLocationId"
            value={pickupLocationId}
            onChange={(event) => setPickupLocationId(event.target.value)}
          >
            {locations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-icon">▣</span>
          <span className="field-label">PICKUP DATE</span>
          <input type="date" name="pickupDate" defaultValue={defaults?.pickupDate} required />
        </label>
        <label className="field">
          <span className="field-icon">◷</span>
          <span className="field-label">PICKUP TIME</span>
          <select name="pickupTime" defaultValue={defaults?.pickupTime ?? "10:00"}>
            {TIME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-icon">▣</span>
          <span className="field-label">RETURN DATE</span>
          <input type="date" name="returnDate" defaultValue={defaults?.returnDate} required />
        </label>
        <label className="field">
          <span className="field-icon">◷</span>
          <span className="field-label">RETURN TIME</span>
          <select name="returnTime" defaultValue={defaults?.returnTime ?? "10:00"}>
            {TIME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button className="search-button" type="submit">
          Search cars <span>→</span>
        </button>
      </form>
      <label className="return-toggle">
        <input
          type="checkbox"
          checked={differentReturn}
          onChange={(event) => setDifferentReturn(event.target.checked)}
        />
        Return to a different location
      </label>
      {differentReturn && (
        <div className="return-location">
          <span>Drop-off location</span>
          <select form={formId} name="dropoffLocationId" defaultValue={defaults?.dropoffLocationId ?? otherLocations[0]?.id}>
            {locations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
