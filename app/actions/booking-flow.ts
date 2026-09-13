"use server";

import { redirect } from "next/navigation";
import {
  selectVehicle,
  repriceForDriver,
  submitBooking,
  type SubmitBookingOutcome,
} from "../../lib/services/booking-flow.service";
import { formatMoney } from "../../lib/money";

// bigint does not round-trip through the Server Actions RPC boundary, so
// every money amount is formatted to a display string here — inside this
// server-only module — before crossing to the client. The client never
// receives a bigint and never formats or computes money itself.
export interface FormattedPriced {
  lineItems: Array<{ description: string; amount: string }>;
  subtotal: string;
  tax: string;
  total: string;
  deposit: string;
}

// Thin "use server" wrappers around lib/services/booking-flow.service.ts.
// Kept separate from that module so the business logic stays importable and
// unit-testable outside a Next.js request context — redirect() throws a
// framework-specific signal that only makes sense here.

// -----------------------------------------------------------------------
// Entering the flow — a real <form> POST from /search, so it works without
// client JS (same philosophy as SearchForm's GET form).
// -----------------------------------------------------------------------

export async function selectVehicleAction(formData: FormData): Promise<void> {
  const vehicleId = String(formData.get("vehicleId") ?? "");
  const pickupLocationId = String(formData.get("pickupLocationId") ?? "");
  const dropoffLocationId = String(formData.get("dropoffLocationId") ?? "");
  const pickupAt = new Date(String(formData.get("pickupAt") ?? ""));
  const returnAt = new Date(String(formData.get("returnAt") ?? ""));

  // Preserved only to rebuild the /search URL on a recovery redirect — none
  // of these are sensitive.
  const searchQuery = new URLSearchParams();
  for (const key of ["pickupLocationId", "dropoffLocationId", "pickupDate", "pickupTime", "returnDate", "returnTime"]) {
    const value = formData.get(key);
    if (typeof value === "string" && value.length > 0) {
      searchQuery.set(key, value);
    }
  }

  const outcome = await selectVehicle({ vehicleId, pickupLocationId, dropoffLocationId, pickupAt, returnAt });

  if (outcome.ok) {
    redirect(`/book/${outcome.quoteId}?step=1`);
  }

  // VEHICLE_UNAVAILABLE is the highest-value recovery path: bounce back to
  // /search (same criteria) with a notice, not an error page — other
  // results are still listed there.
  searchQuery.set("notice", outcome.reason === "VEHICLE_UNAVAILABLE" ? "unavailable" : "select-failed");
  redirect(`/search?${searchQuery.toString()}`);
}

// -----------------------------------------------------------------------
// Step 2 — called directly as a function from the client wizard (not a
// <form action>) so its result can update in-place state instead of
// navigating. Only DOB and licence expiry travel here — the licence NUMBER
// is never part of this call.
// -----------------------------------------------------------------------

export interface RepriceStepTwoInput {
  quoteId: string;
  driverDateOfBirth: string;
  driverLicenceExpiry: string;
}

export type RepriceStepTwoResult = { ok: true; priced: FormattedPriced } | { ok: false; reason: string };

export async function repriceStepTwoAction(input: RepriceStepTwoInput): Promise<RepriceStepTwoResult> {
  const outcome = await repriceForDriver({
    quoteId: input.quoteId,
    driverDateOfBirth: new Date(input.driverDateOfBirth),
    driverLicenceExpiry: new Date(input.driverLicenceExpiry),
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }

  const { result } = outcome;
  return {
    ok: true,
    priced: {
      lineItems: result.lineItems.map((li) => ({ description: li.description, amount: formatMoney(li.totalAmount, result.currency) })),
      subtotal: formatMoney(result.subtotalAmount, result.currency),
      tax: formatMoney(result.taxAmount, result.currency),
      total: formatMoney(result.totalAmount, result.currency),
      deposit: formatMoney(result.securityDeposit, result.currency),
    },
  };
}

// -----------------------------------------------------------------------
// Step 4 — the ONE point in the whole flow where the licence number is
// transmitted to the server. Called directly as a function from the
// client wizard's Submit handler.
// -----------------------------------------------------------------------

export interface SubmitBookingActionInput {
  quoteId: string;
  driverFullName: string;
  driverEmail: string;
  driverPhone: string;
  driverDateOfBirth: string;
  driverLicenceNumber: string;
  driverLicenceCountry: string;
  driverLicenceExpiry: string;
}

export type SubmitBookingActionResult = { ok: false; reason: string };

export async function submitBookingAction(input: SubmitBookingActionInput): Promise<SubmitBookingActionResult> {
  const outcome: SubmitBookingOutcome = await submitBooking({
    quoteId: input.quoteId,
    driverFullName: input.driverFullName,
    driverEmail: input.driverEmail,
    driverPhone: input.driverPhone,
    driverDateOfBirth: new Date(input.driverDateOfBirth),
    driverLicenceNumber: input.driverLicenceNumber,
    driverLicenceCountry: input.driverLicenceCountry,
    driverLicenceExpiry: new Date(input.driverLicenceExpiry),
  });

  if (outcome.ok) {
    // Thrown redirect propagates through the Server Action RPC and the
    // client wizard follows it — the reference is never echoed back as a
    // return value carrying driver data, only the navigation happens.
    redirect(`/booking/confirmation/${outcome.reference}`);
  }

  return { ok: false, reason: outcome.reason };
}
