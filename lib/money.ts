// All money is BigInt in minor units (e.g. PHP centavos). Never float, never
// Number, never a formatted string — formatting is a render concern (see
// formatMoney) and must not feed back into arithmetic.
//
// BigInt literal syntax (0n) requires an ES2020+ compile target; this repo's
// tsconfig targets ES2017, so every BigInt value here is built with the
// BigInt(...) constructor instead.

export type Money = bigint;

const ZERO = BigInt(0);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const TEN_THOUSAND = BigInt(10000);

export function add(a: Money, b: Money): Money {
  return a + b;
}

export function subtract(a: Money, b: Money): Money {
  return a - b;
}

export function multiplyByQty(amount: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new Error("quantity must be an integer");
  }
  return amount * BigInt(quantity);
}

// The single rounding helper for the whole module. Half-up on ties, sign
// preserved. Every division on money (basis-point tax, per-day tier
// conversion) must round through this function exactly once — never
// mid-calculation, never re-rounded downstream.
export function roundDivision(numerator: bigint, denominator: bigint): Money {
  if (denominator === ZERO) {
    throw new Error("division by zero");
  }
  const negative = numerator < ZERO !== denominator < ZERO;
  const absNumerator = numerator < ZERO ? -numerator : numerator;
  const absDenominator = denominator < ZERO ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const roundedAbs = remainder * TWO >= absDenominator ? quotient + BigInt(1) : quotient;
  return negative ? -roundedAbs : roundedAbs;
}

export function applyBasisPoints(amount: Money, bps: number): Money {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error("basis points must be a non-negative integer");
  }
  return roundDivision(amount * BigInt(bps), TEN_THOUSAND);
}

// Server-side only: converts a decimal string as typed into an admin form
// (e.g. "1500" or "1500.50") into minor units. The browser never parses
// money — this is the single place a rate/deposit form field becomes a
// BigInt, called from app/actions/fleet.ts. Returns null on anything that
// isn't a plain non-negative decimal with at most 2 fraction digits.
export function parseMoneyInput(raw: string): Money | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const minor = fractionPart.padEnd(2, "0");
  return BigInt(wholePart) * HUNDRED + BigInt(minor);
}

// Render-only. Never used to feed a number back into arithmetic.
export function formatMoney(amount: Money, currency: string): string {
  const negative = amount < ZERO;
  const abs = negative ? -amount : amount;
  const major = abs / HUNDRED;
  const minor = abs % HUNDRED;
  return `${negative ? "-" : ""}${currency} ${major}.${minor.toString().padStart(2, "0")}`;
}
