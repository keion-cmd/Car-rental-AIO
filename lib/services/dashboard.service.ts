import { PrismaClient, type BookingStatus } from "@prisma/client";
import { type DbClient } from "./availability.service";
import { countsForViews } from "./booking-query.service";
import { deriveVehicleStatuses, type VehicleStatus } from "./fleet.service";
import { getBusinessTimezone } from "./calendar.service";
import { getCurrency } from "./catalog.service";
import { localDayKey, zonedTimeToUtc } from "../timezone";

// The 9am overview: everything a manager must act on today, each a count
// that deep-links to the filtered list behind it. Every flag reused here
// (needsAttention, isOverdue, isStartingToday, isReturningToday, vehicle
// status) is computed exactly once, in the service that already owns it —
// this file adds no second definition of any of them. paymentFailed is the
// one exception because it isn't a saved view: it's a raw
// Booking.paymentStatus read.

export const prisma = new PrismaClient();

export interface ActionQueueItem {
  count: number;
  href: string;
}

export interface ActionQueues {
  overdue: ActionQueueItem;
  pickupsToday: ActionQueueItem;
  returnsToday: ActionQueueItem;
  pendingConfirmation: ActionQueueItem;
  paymentFailed: ActionQueueItem;
}

export interface FleetStatus {
  counts: Record<VehicleStatus, number>;
  totalActive: number;
}

export interface MoneySummary {
  revenueToday: bigint;
  revenueThisWeek: bigint;
  revenueThisMonth: bigint;
  outstandingBalance: bigint;
  currency: string;
}

export interface NextSevenDaysEntry {
  date: string; // YYYY-MM-DD, local to the business timezone
  pickups: number;
  returns: number;
}

export interface RecentActivityRow {
  id: string;
  reference: string;
  customerName: string;
  vehicleLabel: string;
  status: BookingStatus;
  createdAt: Date;
}

export interface DashboardSummary {
  actionQueues: ActionQueues;
  fleetStatus: FleetStatus;
  money: MoneySummary | null;
  nextSevenDays: NextSevenDaysEntry[];
  recentActivity: RecentActivityRow[];
}

function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The UTC instant of local midnight for a YYYY-MM-DD calendar date in
// `timeZone`, via lib/timezone.ts's zonedTimeToUtc. Money periods and the
// 7-day strip are bounded by this, not by UTC midnight — a business east of
// UTC would otherwise have "today"'s revenue window shifted by its offset.
function zonedMidnightUTC(dayKey: string, timeZone: string): Date {
  return zonedTimeToUtc(dayKey, "00:00", timeZone);
}

export async function getDashboardSummary(
  now: Date,
  db: DbClient = prisma,
  includeMoney: boolean = true
): Promise<DashboardSummary> {
  const [counts, timezone, activeVehicles] = await Promise.all([
    countsForViews({}, now),
    getBusinessTimezone(db),
    db.vehicle.findMany({ where: { archivedAt: null }, select: { id: true } }),
  ]);

  const activeIds = activeVehicles.map((v) => v.id);
  const statusById = await deriveVehicleStatuses(activeIds, now, db);

  const fleetCounts = { AVAILABLE: 0, RENTED: 0, RESERVED: 0, MAINTENANCE: 0, BLOCKED: 0 } as Record<VehicleStatus, number>;
  for (const id of activeIds) {
    const status = statusById.get(id) ?? "AVAILABLE";
    fleetCounts[status] += 1;
  }

  const todayKey = localDayKey(now, timezone);
  const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay)).getUTCDay();
  const isoDow = weekday === 0 ? 7 : weekday;
  const weekStartKey = addDaysToKey(todayKey, -(isoDow - 1));
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const weekEndKey = addDaysToKey(todayKey, 7);

  const todayStart = zonedMidnightUTC(todayKey, timezone);
  const weekStart = zonedMidnightUTC(weekStartKey, timezone);
  const monthStart = zonedMidnightUTC(monthStartKey, timezone);
  const weekEnd = zonedMidnightUTC(weekEndKey, timezone);

  const [sevenDayRows, recent] = await Promise.all([
    db.booking.findMany({
      where: {
        OR: [
          { status: "CONFIRMED", pickupAt: { gte: now, lt: weekEnd } },
          { status: "ONGOING", returnAt: { gte: now, lt: weekEnd } },
        ],
      },
      select: { status: true, pickupAt: true, returnAt: true },
    }),
    db.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        reference: true,
        status: true,
        createdAt: true,
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true, model: { select: { make: true, model: true } } } },
      },
    }),
  ]);

  let paymentFailedCount = 0;
  let money: MoneySummary | null = null;

  if (includeMoney) {
    // One unfiltered read of every booking's money-relevant fields, not a
    // per-metric aggregate query: paymentFailed, outstandingBalance and all
    // three revenue periods are derived from the same in-memory pass. Same
    // "dataset small enough" trade-off booking-query.service already makes
    // for its saved-view counts.
    const [allBookings, currency] = await Promise.all([
      db.booking.findMany({
        select: { status: true, paymentStatus: true, totalAmount: true, amountPaid: true, checkedInAt: true },
      }),
      getCurrency(),
    ]);

    let outstandingBalance = BigInt(0);
    let revenueToday = BigInt(0);
    let revenueThisWeek = BigInt(0);
    let revenueThisMonth = BigInt(0);
    for (const b of allBookings) {
      if (b.paymentStatus === "FAILED") paymentFailedCount += 1;
      if (b.paymentStatus === "UNPAID" || b.paymentStatus === "PARTIALLY_PAID") {
        outstandingBalance += b.totalAmount - b.amountPaid;
      }
      if (b.status === "COMPLETED" && b.checkedInAt && b.checkedInAt.getTime() >= monthStart.getTime()) {
        revenueThisMonth += b.totalAmount;
        if (b.checkedInAt.getTime() >= weekStart.getTime()) revenueThisWeek += b.totalAmount;
        if (b.checkedInAt.getTime() >= todayStart.getTime()) revenueToday += b.totalAmount;
      }
    }
    money = { revenueToday, revenueThisWeek, revenueThisMonth, outstandingBalance, currency };
  } else {
    // STAFF never triggers the full booking scan above — only the cheap
    // grouped count needed for the paymentFailed action queue, which every
    // role sees regardless of the money gate.
    const paymentGroups = await db.booking.groupBy({ by: ["paymentStatus"], _count: { _all: true } });
    for (const group of paymentGroups) {
      if (group.paymentStatus === "FAILED") paymentFailedCount = group._count._all;
    }
  }

  const dayKeys = Array.from({ length: 7 }, (_, i) => addDaysToKey(todayKey, i));
  const nextSevenDays: NextSevenDaysEntry[] = dayKeys.map((date) => ({ date, pickups: 0, returns: 0 }));
  const indexByKey = new Map(dayKeys.map((k, i) => [k, i]));
  for (const row of sevenDayRows) {
    if (row.status === "CONFIRMED") {
      const key = localDayKey(row.pickupAt, timezone);
      const idx = indexByKey.get(key);
      if (idx !== undefined) nextSevenDays[idx].pickups += 1;
    } else if (row.status === "ONGOING") {
      const key = localDayKey(row.returnAt, timezone);
      const idx = indexByKey.get(key);
      if (idx !== undefined) nextSevenDays[idx].returns += 1;
    }
  }

  const recentActivity: RecentActivityRow[] = recent.map((b) => ({
    id: b.id,
    reference: b.reference,
    customerName: b.customer.name,
    vehicleLabel: `${b.vehicle.model.make} ${b.vehicle.model.model} (${b.vehicle.plateNumber})`,
    status: b.status,
    createdAt: b.createdAt,
  }));

  return {
    actionQueues: {
      overdue: { count: counts.overdue, href: "/admin/bookings?view=overdue" },
      pickupsToday: { count: counts.startingToday, href: "/admin/bookings?view=startingToday" },
      returnsToday: { count: counts.returningToday, href: "/admin/bookings?view=returningToday" },
      pendingConfirmation: { count: counts.pending, href: "/admin/bookings?view=pending" },
      paymentFailed: { count: paymentFailedCount, href: "/admin/bookings?paymentStatus=FAILED" },
    },
    fleetStatus: { counts: fleetCounts, totalActive: activeIds.length },
    money,
    nextSevenDays,
    recentActivity,
  };
}

export const NEEDS_ATTENTION_HREF = "/admin/bookings?view=needsAttention";
