import { PrismaClient, type BookingStatus, type PaymentStatus, type CustomerFlag } from "@prisma/client";
import { listLocations } from "./catalog.service";
import { computeBookingFlags, type BookingFlags } from "./booking-query.service";

// Read-only queries behind the staff customer list/detail screens. Never
// writes — all writes stay in customer.service.ts. STATS ARE DERIVED, NEVER
// STORED: total bookings, completed, cancelled, lifetime revenue, average
// rental length and outstanding balance are all computed HERE, once, from
// each customer's bookings against the caller-supplied `now` — never a
// stored counter, which would drift the first time a booking is cancelled.
//
// Never selects Booking.driverLicenceNumber — nothing below reads or
// returns it.

export const prisma = new PrismaClient();

const DEFAULT_LIMIT = 20;

function balanceDueFor(totalAmount: bigint, amountPaid: bigint): bigint {
  return totalAmount - amountPaid;
}

async function getBillingGraceMinutes(): Promise<number> {
  const settings = await prisma.settings.findFirst({ select: { billingGraceMinutes: true } });
  return settings?.billingGraceMinutes ?? 59;
}

interface BookingForStats {
  status: BookingStatus;
  totalAmount: bigint;
  amountPaid: bigint;
  rentalDays: number;
}

export interface CustomerStats {
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  // COMPLETED bookings only — a PENDING or CANCELLED booking never earned
  // the business anything.
  lifetimeRevenue: bigint;
  // Summed across every non-cancelled booking whose balance is still
  // positive. A CANCELLED booking was never fulfilled, so its total never
  // became a debt.
  outstandingBalance: bigint;
  averageRentalDays: number;
}

function computeStats(bookings: BookingForStats[]): CustomerStats {
  const completed = bookings.filter((b) => b.status === "COMPLETED");
  const cancelled = bookings.filter((b) => b.status === "CANCELLED");

  const lifetimeRevenue = completed.reduce((sum, b) => sum + b.totalAmount, BigInt(0));

  const outstandingBalance = bookings
    .filter((b) => b.status !== "CANCELLED")
    .reduce((sum, b) => {
      const due = balanceDueFor(b.totalAmount, b.amountPaid);
      return due > BigInt(0) ? sum + due : sum;
    }, BigInt(0));

  const averageRentalDays =
    completed.length > 0 ? completed.reduce((sum, b) => sum + b.rentalDays, 0) / completed.length : 0;

  return {
    totalBookings: bookings.length,
    completedBookings: completed.length,
    cancelledBookings: cancelled.length,
    lifetimeRevenue,
    outstandingBalance,
    averageRentalDays,
  };
}

// ==================== LIST ====================

export interface ListCustomersFilters {
  search?: string;
  hasActiveRental?: boolean;
  hasOutstandingBalance?: boolean;
  flagged?: boolean;
  // 2 or more COMPLETED bookings.
  repeatCustomer?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface Pagination {
  cursor?: string;
  limit?: number;
}

export interface CustomerListRow extends CustomerStats {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  // Most recent pickup among ONGOING/COMPLETED bookings — a PENDING or
  // CONFIRMED booking has not actually happened yet.
  lastRentalAt: Date | null;
  hasActiveRental: boolean;
  flag: CustomerFlag | null;
  createdAt: Date;
}

export interface ListCustomersResult {
  rows: CustomerListRow[];
  nextCursor: string | null;
}

type RawCustomerRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  flag: CustomerFlag | null;
  createdAt: Date;
  bookings: Array<{
    status: BookingStatus;
    totalAmount: bigint;
    amountPaid: bigint;
    rentalDays: number;
    pickupAt: Date;
  }>;
};

const CUSTOMER_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  flag: true,
  createdAt: true,
  bookings: {
    select: { status: true, totalAmount: true, amountPaid: true, rentalDays: true, pickupAt: true },
  },
} as const;

function toListRow(c: RawCustomerRow): CustomerListRow {
  const stats = computeStats(c.bookings);
  const rentalPickups = c.bookings.filter((b) => b.status === "ONGOING" || b.status === "COMPLETED").map((b) => b.pickupAt);
  const lastRentalAt = rentalPickups.length > 0 ? new Date(Math.max(...rentalPickups.map((d) => d.getTime()))) : null;

  return {
    ...stats,
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    lastRentalAt,
    hasActiveRental: c.bookings.some((b) => b.status === "ONGOING"),
    flag: c.flag,
    createdAt: c.createdAt,
  };
}

// Fetches every customer matching the DB-pushable filters (search, created
// date range), computes derived stats in-process, then applies the
// stats-dependent filters (active rental, outstanding balance, flagged,
// repeat) there too — this admin dataset is small enough for that, same
// reasoning booking-query.service uses for its saved views.
async function queryFiltered(filters: ListCustomersFilters): Promise<CustomerListRow[]> {
  const where: Record<string, unknown> = {};

  if (filters.search) {
    const term = filters.search.trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
      ];
    }
  }
  if (filters.createdFrom || filters.createdTo) {
    where.createdAt = {
      ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
      ...(filters.createdTo ? { lte: filters.createdTo } : {}),
    };
  }

  const rawRows = await prisma.customer.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: CUSTOMER_LIST_SELECT,
  });

  let rows = rawRows.map((r) => toListRow(r as unknown as RawCustomerRow));

  if (filters.hasActiveRental) rows = rows.filter((r) => r.hasActiveRental);
  if (filters.hasOutstandingBalance) rows = rows.filter((r) => r.outstandingBalance > BigInt(0));
  if (filters.flagged) rows = rows.filter((r) => r.flag !== null);
  if (filters.repeatCustomer) rows = rows.filter((r) => r.completedBookings >= 2);

  return rows;
}

export async function listCustomers(
  filters: ListCustomersFilters,
  pagination: Pagination,
  // Accepted for interface symmetry with listBookings/getCustomerDetail — no
  // stat computed by listCustomers itself depends on wall-clock time (unlike
  // getCustomerDetail's currentRental, which does).
  now: Date = new Date()
): Promise<ListCustomersResult> {
  void now;
  const rows = await queryFiltered(filters);
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

// ==================== DETAIL ====================

export interface CustomerCurrentRental extends BookingFlags {
  id: string;
  reference: string;
  vehicleLabel: string;
  pickupAt: Date;
  returnAt: Date;
  status: BookingStatus;
}

export interface CustomerBookingHistoryRow {
  id: string;
  reference: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  pickupAt: Date;
  returnAt: Date;
  totalAmount: bigint;
  balanceDue: bigint;
  currency: string;
}

export interface CustomerDetail extends CustomerStats {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  staffNotes: string | null;
  flag: CustomerFlag | null;
  flagReason: string | null;
  flaggedAt: Date | null;
  flaggedBy: { id: string; name: string } | null;
  currentRental: CustomerCurrentRental | null;
  bookingHistory: CustomerBookingHistoryRow[];
  createdAt: Date;
}

export async function getCustomerDetail(id: string, now: Date = new Date()): Promise<CustomerDetail | null> {
  const [customer, locationList, billingGraceMinutes] = await Promise.all([
    prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        staffNotes: true,
        flag: true,
        flagReason: true,
        flaggedAt: true,
        flaggedBy: { select: { id: true, name: true } },
        createdAt: true,
        bookings: {
          select: {
            id: true,
            reference: true,
            status: true,
            paymentStatus: true,
            pickupAt: true,
            returnAt: true,
            pickupLocationId: true,
            totalAmount: true,
            amountPaid: true,
            currency: true,
            rentalDays: true,
            createdAt: true,
            vehicle: { select: { model: { select: { make: true, model: true } } } },
          },
          orderBy: { pickupAt: "desc" },
        },
      },
    }),
    listLocations(),
    getBillingGraceMinutes(),
  ]);

  if (!customer) return null;

  const locations = new Map(locationList.map((l) => [l.id, l]));
  const stats = computeStats(customer.bookings);

  const ongoing = customer.bookings.find((b) => b.status === "ONGOING") ?? null;
  const currentRental: CustomerCurrentRental | null = ongoing
    ? {
        ...computeBookingFlags(ongoing, locations.get(ongoing.pickupLocationId)?.timezone ?? "UTC", now, billingGraceMinutes),
        id: ongoing.id,
        reference: ongoing.reference,
        vehicleLabel: `${ongoing.vehicle.model.make} ${ongoing.vehicle.model.model}`,
        pickupAt: ongoing.pickupAt,
        returnAt: ongoing.returnAt,
        status: ongoing.status,
      }
    : null;

  return {
    ...stats,
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    staffNotes: customer.staffNotes,
    flag: customer.flag,
    flagReason: customer.flagReason,
    flaggedAt: customer.flaggedAt,
    flaggedBy: customer.flaggedBy,
    currentRental,
    bookingHistory: customer.bookings.map((b) => ({
      id: b.id,
      reference: b.reference,
      status: b.status,
      paymentStatus: b.paymentStatus,
      pickupAt: b.pickupAt,
      returnAt: b.returnAt,
      totalAmount: b.totalAmount,
      balanceDue: balanceDueFor(b.totalAmount, b.amountPaid),
      currency: b.currency,
    })),
    createdAt: customer.createdAt,
  };
}
