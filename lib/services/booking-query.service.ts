import { PrismaClient, type Booking, type BookingStatus, type PaymentStatus } from "@prisma/client";
import { listLocations, type CatalogLocation } from "./catalog.service";

// Read-only queries behind the staff bookings list/detail screens. Never
// writes to bookings/booking_line_items/vehicle_blocks — all writes stay in
// booking.service.ts. Derived operational flags (isOverdue,
// isStartingToday, isReturningToday, needsAttention) are computed HERE,
// once, against the caller-supplied `now` — never stored on a row, never
// recomputed in a component.

export const prisma = new PrismaClient();

export type SavedView =
  | "needsAttention"
  | "startingToday"
  | "returningToday"
  | "ongoing"
  | "upcoming"
  | "pending"
  | "overdue"
  | "all";

export const SAVED_VIEWS: { id: SavedView; label: string; emptyDescription: string }[] = [
  { id: "needsAttention", label: "Needs attention", emptyDescription: "Nothing is stuck: no stale pending bookings, no failed payments, no overdue returns." },
  { id: "startingToday", label: "Today's pickups", emptyDescription: "No confirmed booking has a pickup today at its pickup location." },
  { id: "returningToday", label: "Today's returns", emptyDescription: "No ongoing rental is due back today at its pickup location." },
  { id: "ongoing", label: "Ongoing", emptyDescription: "No rental is currently checked out." },
  { id: "upcoming", label: "Upcoming", emptyDescription: "No confirmed booking is waiting on a future pickup." },
  { id: "pending", label: "Pending", emptyDescription: "No booking is waiting on confirmation." },
  { id: "overdue", label: "Overdue", emptyDescription: "No ongoing rental is past its return window." },
  { id: "all", label: "All", emptyDescription: "No bookings match the current filters." },
];

export interface BookingFlags {
  isOverdue: boolean;
  isStartingToday: boolean;
  isReturningToday: boolean;
  needsAttention: boolean;
}

// A booking is a stale pending lead 2 hours after it was created. Payment
// FAILED does not exist in the PaymentStatus enum (UNPAID / PARTIALLY_PAID /
// PAID / REFUNDED only) — inventing it is out of scope (AGENTS.md), so that
// clause of the original "needsAttention" definition is omitted here.
const PENDING_STALE_MS = 2 * 60 * 60 * 1000;

function localDateString(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, giving a directly comparable calendar date
  // string for the wall-clock day in `timeZone` — no external tz library.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function computeBookingFlags(
  booking: { status: BookingStatus; paymentStatus: PaymentStatus; pickupAt: Date; returnAt: Date; createdAt: Date },
  pickupLocationTimezone: string,
  now: Date,
  billingGraceMinutes: number
): BookingFlags {
  const isOverdue =
    booking.status === "ONGOING" && now.getTime() > booking.returnAt.getTime() + billingGraceMinutes * 60_000;

  const todayAtPickupLocation = localDateString(now, pickupLocationTimezone);
  const isStartingToday =
    booking.status === "CONFIRMED" && localDateString(booking.pickupAt, pickupLocationTimezone) === todayAtPickupLocation;
  const isReturningToday =
    booking.status === "ONGOING" && localDateString(booking.returnAt, pickupLocationTimezone) === todayAtPickupLocation;

  const isPendingStale = booking.status === "PENDING" && now.getTime() - booking.createdAt.getTime() > PENDING_STALE_MS;
  const needsAttention = isPendingStale || isOverdue;

  return { isOverdue, isStartingToday, isReturningToday, needsAttention };
}

function matchesView(view: SavedView, flags: BookingFlags, status: BookingStatus): boolean {
  switch (view) {
    case "needsAttention":
      return flags.needsAttention;
    case "startingToday":
      return flags.isStartingToday;
    case "returningToday":
      return flags.isReturningToday;
    case "ongoing":
      return status === "ONGOING";
    case "upcoming":
      return status === "CONFIRMED";
    case "pending":
      return status === "PENDING";
    case "overdue":
      return flags.isOverdue;
    case "all":
      return true;
  }
}

export interface BookingListRow extends BookingFlags {
  id: string;
  reference: string;
  customerName: string;
  customerEmail: string;
  vehicleLabel: string;
  plateNumber: string;
  pickupAt: Date;
  pickupLocationName: string;
  pickupLocationTimezone: string;
  returnAt: Date;
  dropoffLocationName: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  totalAmount: bigint;
  currency: string;
  // null means "cannot be derived" — there is no payment-ledger/amountPaid
  // column on Booking, so a PARTIALLY_PAID balance is genuinely unknown
  // rather than computable. See getBookingDetail's doc comment.
  balanceDue: bigint | null;
  createdAt: Date;
}

export type SortField = "pickup" | "return" | "created" | "total";
export type SortDir = "asc" | "desc";

export interface ListBookingsFilters {
  view?: SavedView;
  search?: string;
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  pickupLocationId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: SortField;
  sortDir?: SortDir;
}

export interface Pagination {
  cursor?: string;
  limit?: number;
}

export interface ListBookingsResult {
  rows: BookingListRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;

function balanceDueFor(paymentStatus: PaymentStatus, totalAmount: bigint): bigint | null {
  if (paymentStatus === "PAID" || paymentStatus === "REFUNDED") return BigInt(0);
  if (paymentStatus === "UNPAID") return totalAmount;
  return null; // PARTIALLY_PAID — amount paid is not tracked anywhere yet
}

const BASE_SELECT = {
  id: true,
  reference: true,
  pickupAt: true,
  returnAt: true,
  pickupLocationId: true,
  dropoffLocationId: true,
  status: true,
  paymentStatus: true,
  totalAmount: true,
  currency: true,
  createdAt: true,
  customer: { select: { name: true, email: true, phone: true } },
  vehicle: { select: { plateNumber: true, model: { select: { make: true, model: true } } } },
} as const;

type RawBookingRow = {
  id: string;
  reference: string;
  pickupAt: Date;
  returnAt: Date;
  pickupLocationId: string;
  dropoffLocationId: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  totalAmount: bigint;
  currency: string;
  createdAt: Date;
  customer: { name: string; email: string; phone: string | null };
  vehicle: { plateNumber: string; model: { make: string; model: string } };
};

function toRow(b: RawBookingRow, locations: Map<string, CatalogLocation>, now: Date, billingGraceMinutes: number): BookingListRow {
  const pickupLocation = locations.get(b.pickupLocationId);
  const dropoffLocation = locations.get(b.dropoffLocationId);
  const pickupLocationTimezone = pickupLocation?.timezone ?? "UTC";
  const flags = computeBookingFlags(b, pickupLocationTimezone, now, billingGraceMinutes);

  return {
    ...flags,
    id: b.id,
    reference: b.reference,
    customerName: b.customer.name,
    customerEmail: b.customer.email,
    vehicleLabel: `${b.vehicle.model.make} ${b.vehicle.model.model}`,
    plateNumber: b.vehicle.plateNumber,
    pickupAt: b.pickupAt,
    pickupLocationName: pickupLocation?.name ?? "Unknown location",
    pickupLocationTimezone,
    returnAt: b.returnAt,
    dropoffLocationName: dropoffLocation?.name ?? "Unknown location",
    status: b.status,
    paymentStatus: b.paymentStatus,
    totalAmount: b.totalAmount,
    currency: b.currency,
    balanceDue: balanceDueFor(b.paymentStatus, b.totalAmount),
    createdAt: b.createdAt,
  };
}

async function getBillingGraceMinutes(): Promise<number> {
  const settings = await prisma.settings.findFirst({ select: { billingGraceMinutes: true } });
  return settings?.billingGraceMinutes ?? 59;
}

// Fetches every booking matching the non-view filters, computes flags, and
// applies the view predicate in-process. This repo's admin dataset is small
// enough that this is simple and correct; a table growing into the millions
// would want the view predicate pushed into SQL instead (it would need a
// join to locations for the timezone-dependent flags).
async function queryFiltered(filters: ListBookingsFilters, now: Date): Promise<BookingListRow[]> {
  const where: Record<string, unknown> = {};

  if (filters.status) where.status = filters.status;
  if (filters.paymentStatus) where.paymentStatus = filters.paymentStatus;
  if (filters.pickupLocationId) where.pickupLocationId = filters.pickupLocationId;
  if (filters.dateFrom || filters.dateTo) {
    where.pickupAt = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }
  if (filters.search) {
    const term = filters.search.trim();
    if (term) {
      where.OR = [
        { reference: { contains: term, mode: "insensitive" } },
        { customer: { name: { contains: term, mode: "insensitive" } } },
        { customer: { email: { contains: term, mode: "insensitive" } } },
        { customer: { phone: { contains: term, mode: "insensitive" } } },
        { vehicle: { plateNumber: { contains: term, mode: "insensitive" } } },
      ];
    }
  }

  const sortField: SortField = filters.sortBy ?? "pickup";
  const sortDir: SortDir = filters.sortDir ?? "asc";
  const sortColumn = { pickup: "pickupAt", return: "returnAt", created: "createdAt", total: "totalAmount" }[sortField];

  const [rawRows, locationList, billingGraceMinutes] = await Promise.all([
    prisma.booking.findMany({
      where,
      // id as a stable tie-breaker keeps pagination deterministic when the
      // primary sort column has duplicate values.
      orderBy: [{ [sortColumn]: sortDir }, { id: "asc" }],
      select: BASE_SELECT,
    }),
    listLocations(),
    getBillingGraceMinutes(),
  ]);

  const locations = new Map(locationList.map((l) => [l.id, l]));
  const rows = rawRows.map((r) => toRow(r as unknown as RawBookingRow, locations, now, billingGraceMinutes));

  const view = filters.view ?? "all";
  return rows.filter((r) => matchesView(view, r, r.status));
}

export async function listBookings(
  filters: ListBookingsFilters,
  pagination: Pagination,
  now: Date = new Date()
): Promise<ListBookingsResult> {
  const rows = await queryFiltered(filters, now);
  const limit = pagination.limit ?? DEFAULT_LIMIT;

  let startIndex = 0;
  if (pagination.cursor) {
    const cursorIndex = rows.findIndex((r) => r.id === pagination.cursor);
    startIndex = cursorIndex === -1 ? 0 : cursorIndex + 1;
  }

  const page = rows.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < rows.length ? page[page.length - 1].id : null;

  return { rows: page, nextCursor };
}

export async function countsForViews(
  filters: Omit<ListBookingsFilters, "view"> = {},
  now: Date = new Date()
): Promise<Record<SavedView, number>> {
  const rowsWithoutView = await queryFiltered(filters, now);
  const counts = {} as Record<SavedView, number>;
  for (const view of SAVED_VIEWS) {
    counts[view.id] = rowsWithoutView.filter((r) => matchesView(view.id, r, r.status)).length;
  }
  return counts;
}

export interface BookingDetail extends BookingFlags {
  id: string;
  reference: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  source: Booking["source"];
  pickupAt: Date;
  returnAt: Date;
  pickupLocation: CatalogLocation | null;
  dropoffLocation: CatalogLocation | null;
  customer: { id: string; name: string; email: string; phone: string | null };
  vehicle: { id: string; plateNumber: string; make: string; model: string };
  subtotalAmount: bigint;
  taxAmount: bigint;
  securityDeposit: bigint;
  totalAmount: bigint;
  balanceDue: bigint | null;
  currency: string;
  rentalDays: number;
  lineItems: Array<{
    id: string;
    type: string;
    description: string;
    quantity: number;
    unitAmount: bigint;
    totalAmount: bigint;
    isTaxable: boolean;
  }>;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  // Driver fields exclude driverLicenceNumber by construction — see
  // getDriverLicenceNumber in booking.service.ts for the one path that may
  // read it, with its own justification.
  driver: {
    fullName: string;
    email: string;
    phone: string;
    dateOfBirth: null; // Booking has no driver DOB column; only Customer does, and it's optional there.
    licenceCountry: string;
    licenceExpiry: Date;
  };
  createdAt: Date;
  // This schema has no internal-notes column on Booking (or anywhere else
  // tied to a booking) — per AGENTS.md, do not add one. Nothing to render.
  internalNotes: null;
}

export async function getBookingDetail(id: string, now: Date = new Date()): Promise<BookingDetail | null> {
  const [booking, locationList, billingGraceMinutes] = await Promise.all([
    prisma.booking.findUnique({
      where: { id },
      omit: { driverLicenceNumber: true },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        vehicle: { select: { id: true, plateNumber: true, model: { select: { make: true, model: true } } } },
        lineItems: { orderBy: { sortOrder: "asc" } },
      },
    }),
    listLocations(),
    getBillingGraceMinutes(),
  ]);

  if (!booking) return null;

  const locations = new Map(locationList.map((l) => [l.id, l]));
  const pickupLocation = locations.get(booking.pickupLocationId) ?? null;
  const dropoffLocation = locations.get(booking.dropoffLocationId) ?? null;
  const flags = computeBookingFlags(booking, pickupLocation?.timezone ?? "UTC", now, billingGraceMinutes);

  return {
    ...flags,
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    source: booking.source,
    pickupAt: booking.pickupAt,
    returnAt: booking.returnAt,
    pickupLocation,
    dropoffLocation,
    customer: booking.customer,
    vehicle: {
      id: booking.vehicle.id,
      plateNumber: booking.vehicle.plateNumber,
      make: booking.vehicle.model.make,
      model: booking.vehicle.model.model,
    },
    subtotalAmount: booking.subtotalAmount,
    taxAmount: booking.taxAmount,
    securityDeposit: booking.securityDeposit,
    totalAmount: booking.totalAmount,
    balanceDue: balanceDueFor(booking.paymentStatus, booking.totalAmount),
    currency: booking.currency,
    rentalDays: booking.rentalDays,
    lineItems: booking.lineItems.map((li) => ({
      id: li.id,
      type: li.type,
      description: li.description,
      quantity: li.quantity,
      unitAmount: li.unitAmount,
      totalAmount: li.totalAmount,
      isTaxable: li.isTaxable,
    })),
    cancellationReason: booking.cancellationReason,
    cancelledAt: booking.cancelledAt,
    driver: {
      fullName: booking.driverFullName,
      email: booking.driverEmail,
      phone: booking.driverPhone,
      dateOfBirth: null,
      licenceCountry: booking.driverLicenceCountry,
      licenceExpiry: booking.driverLicenceExpiry,
    },
    createdAt: booking.createdAt,
    internalNotes: null,
  };
}
