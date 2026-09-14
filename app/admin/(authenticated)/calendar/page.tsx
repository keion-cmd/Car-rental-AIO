import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";
import { Card } from "../../../components/admin/Card";
import { listLocations } from "../../../../lib/services/catalog.service";
import { listVehicleCategories } from "../../../../lib/services/fleet.service";
import { getFleetCalendar, getBusinessTimezone, type CalendarBlock, type CalendarVehicleRow } from "../../../../lib/services/calendar.service";
import { zonedTimeToUtc, localDayKey } from "../../../../lib/timezone";
import type { BlockType } from "@prisma/client";

export const metadata: Metadata = {
  title: "Calendar | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type RawParams = Record<string, string | string[] | undefined>;
type CalendarView = "day" | "week" | "month";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const ROW_LIMIT = 60;

// Plain calendar-date arithmetic (no timezone conversion) — dateStr is
// already a wall-clock YYYY-MM-DD, so shifting it by whole days never
// crosses a DST boundary in a way that matters here.
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(dateStr, diff);
}

function firstOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function daysInMonth(dateStr: string): number {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface WindowInfo {
  from: Date;
  to: Date;
  columns: Array<{ key: string; label: string }>;
}

function buildWindow(view: CalendarView, anchorDateStr: string, timeZone: string): WindowInfo {
  if (view === "day") {
    const from = zonedTimeToUtc(anchorDateStr, "00:00", timeZone);
    const to = zonedTimeToUtc(addDays(anchorDateStr, 1), "00:00", timeZone);
    const columns = Array.from({ length: 24 }, (_, h) => ({
      key: String(h),
      label: `${String(h).padStart(2, "0")}:00`,
    }));
    return { from, to, columns };
  }
  if (view === "month") {
    const start = firstOfMonth(anchorDateStr);
    const n = daysInMonth(start);
    const from = zonedTimeToUtc(start, "00:00", timeZone);
    const to = zonedTimeToUtc(addDays(start, n), "00:00", timeZone);
    const columns = Array.from({ length: n }, (_, i) => {
      const key = addDays(start, i);
      return { key, label: key.slice(8, 10) };
    });
    return { from, to, columns };
  }
  // week (default)
  const monday = mondayOf(anchorDateStr);
  const from = zonedTimeToUtc(monday, "00:00", timeZone);
  const to = zonedTimeToUtc(addDays(monday, 7), "00:00", timeZone);
  const columns = Array.from({ length: 7 }, (_, i) => {
    const key = addDays(monday, i);
    return { key, label: new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", day: "numeric" }) };
  });
  return { from, to, columns };
}

function pctSpan(
  segStart: number,
  segEnd: number,
  winStart: number,
  winEnd: number
): { leftPct: number; widthPct: number } | null {
  const s = Math.max(segStart, winStart);
  const e = Math.min(segEnd, winEnd);
  if (e <= s) return null;
  const span = winEnd - winStart;
  return { leftPct: ((s - winStart) / span) * 100, widthPct: ((e - s) / span) * 100 };
}

const BLOCK_STYLE: Record<BlockType, { cls: string; icon: string; label: string }> = {
  BOOKING: { cls: "cal-bar-booking", icon: "▶", label: "Booking" },
  HOLD: { cls: "cal-bar-hold", icon: "◐", label: "Hold" },
  MAINTENANCE: { cls: "cal-bar-maintenance", icon: "⚙", label: "Maintenance" },
  MANUAL: { cls: "cal-bar-manual", icon: "✕", label: "Manual" },
  TRANSFER: { cls: "cal-bar-transfer", icon: "⇄", label: "Transfer" },
};

function blockHref(block: CalendarBlock, vehicleId: string): string | null {
  if (block.bookingId) return `/admin/bookings/${block.bookingId}`;
  if (block.blockType === "MAINTENANCE" || block.blockType === "MANUAL" || block.blockType === "TRANSFER") {
    return `/admin/fleet/${vehicleId}`;
  }
  return null;
}

function renderBar(block: CalendarBlock, vehicleId: string, winStart: number, winEnd: number, key: string) {
  const style = BLOCK_STYLE[block.blockType];
  const bufferedSpan = pctSpan(block.bufferedStart.getTime(), block.bufferedEnd.getTime(), winStart, winEnd);
  if (!bufferedSpan) return null;

  const prepSpan =
    block.rentalStart.getTime() > block.bufferedStart.getTime()
      ? pctSpan(block.bufferedStart.getTime(), block.rentalStart.getTime(), winStart, winEnd)
      : null;
  const rentalSpan = pctSpan(block.rentalStart.getTime(), block.rentalEnd.getTime(), winStart, winEnd);
  const turnaroundSpan =
    block.bufferedEnd.getTime() > block.rentalEnd.getTime()
      ? pctSpan(block.rentalEnd.getTime(), block.bufferedEnd.getTime(), winStart, winEnd)
      : null;

  const href = blockHref(block, vehicleId);
  const title = `${style.label}${block.bookingReference ? ` ${block.bookingReference}` : ""}${block.customerName ? ` — ${block.customerName}` : ""}${block.maintenanceType ? ` (${block.maintenanceType})` : ""}${block.isOverdue ? " — OVERDUE" : ""}`;

  const inner = (
    <>
      {prepSpan && (
        <span className="cal-bar-buffer" style={{ left: `${prepSpan.leftPct}%`, width: `${prepSpan.widthPct}%` }} />
      )}
      {rentalSpan && (
        <span
          className={`cal-bar-solid ${style.cls}`}
          style={{ left: `${rentalSpan.leftPct}%`, width: `${rentalSpan.widthPct}%` }}
        >
          <span className="cal-bar-icon" aria-hidden="true">{style.icon}</span>
          <span className="cal-bar-label">
            {style.label}
            {block.bookingReference ? ` · ${block.bookingReference}` : ""}
            {block.customerName ? ` · ${block.customerName}` : ""}
          </span>
          {block.isOverdue && <span className="cal-bar-overdue-flag">OVERDUE</span>}
          {block.clippedStart && <span className="cal-bar-clip cal-bar-clip-start" aria-hidden="true" />}
          {block.clippedEnd && <span className="cal-bar-clip cal-bar-clip-end" aria-hidden="true" />}
        </span>
      )}
      {turnaroundSpan && (
        <span className="cal-bar-buffer" style={{ left: `${turnaroundSpan.leftPct}%`, width: `${turnaroundSpan.widthPct}%` }} />
      )}
    </>
  );

  if (href) {
    return (
      <Link key={key} href={href} className="cal-bar-wrap" title={title}>
        {inner}
      </Link>
    );
  }
  return (
    <span key={key} className="cal-bar-wrap" title={title}>
      {inner}
    </span>
  );
}

function buildQuery(base: RawParams, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (key === "page") continue; // never carry a stale row-page across a filter/view/date change
    const v = one(value);
    if (v) params.set(key, v);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

export default async function AdminCalendarPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireAuth("STAFF");
  const raw = await searchParams;

  const view = ((one(raw.view) as CalendarView | undefined) ?? "week") as CalendarView;
  const locationId = one(raw.locationId);
  const categoryId = one(raw.categoryId);
  const conflictsOnly = one(raw.conflicts) === "true";
  const page = Math.max(0, Number.parseInt(one(raw.page) ?? "0", 10) || 0);

  const now = new Date();
  const [locations, categories] = await Promise.all([listLocations(), listVehicleCategories()]);

  const filteredLocation = locationId ? locations.find((l) => l.id === locationId) : undefined;
  // Across multiple locations there is no single location timezone to use —
  // fall back to the business's own configured timezone (Settings.businessTimezone).
  const businessTimezone = await getBusinessTimezone();
  const referenceTimezone = filteredLocation?.timezone ?? businessTimezone;

  const anchorDateStr = one(raw.date) ?? localDayKey(now, referenceTimezone);
  const { from, to, columns } = buildWindow(view, anchorDateStr, referenceTimezone);

  const { vehicles, totalVehicleCount } = await getFleetCalendar(
    { from, to, locationId, categoryId, onlyConflictsOrOverdue: conflictsOnly, rowOffset: page * ROW_LIMIT, rowLimit: ROW_LIMIT },
    now
  );

  const winStart = from.getTime();
  const winEnd = to.getTime();
  const nowPct = view === "day" && now.getTime() >= winStart && now.getTime() <= winEnd ? ((now.getTime() - winStart) / (winEnd - winStart)) * 100 : null;

  // Rows grouped by category when a single location is in view, or by
  // location when the calendar spans the whole fleet.
  const groupKey = (v: CalendarVehicleRow) => (locationId ? v.categoryName : v.locationName);
  const groups = new Map<string, CalendarVehicleRow[]>();
  for (const v of vehicles) {
    const k = groupKey(v);
    const list = groups.get(k) ?? [];
    list.push(v);
    groups.set(k, list);
  }

  const prevDate = addDays(anchorDateStr, view === "day" ? -1 : view === "week" ? -7 : -daysInMonth(firstOfMonth(anchorDateStr)));
  const nextDate = addDays(anchorDateStr, view === "day" ? 1 : view === "week" ? 7 : daysInMonth(firstOfMonth(anchorDateStr)));
  const todayDate = localDayKey(now, referenceTimezone);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Fleet occupancy across every vehicle, day by day — rows are vehicles, columns are time, bars are blocks."
      />

      <div className="admin-tabs">
        {(["day", "week", "month"] as CalendarView[]).map((v) => (
          <Link
            key={v}
            href={`/admin/calendar?${buildQuery(raw, { view: v })}`}
            className={`admin-tab${v === view ? " admin-tab-active" : ""}`}
          >
            {v[0].toUpperCase() + v.slice(1)}
          </Link>
        ))}
      </div>

      <Card className="admin-filter-bar">
        <form method="get" className="admin-filter-form">
          <input type="hidden" name="view" value={view} />
          <select name="locationId" defaultValue={locationId ?? ""}>
            <option value="">Every location ({businessTimezone} columns)</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <select name="categoryId" defaultValue={categoryId ?? ""}>
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <label className="admin-filter-date">
            <input type="checkbox" name="conflicts" value="true" defaultChecked={conflictsOnly} />
            Conflicts &amp; overdue only
          </label>
          <button type="submit" className="outline-button">Apply</button>
        </form>
      </Card>

      <div className="cal-nav">
        <div className="cal-nav-buttons">
          <Link href={`/admin/calendar?${buildQuery(raw, { date: prevDate })}`} className="outline-button">← Previous</Link>
          <Link href={`/admin/calendar?${buildQuery(raw, { date: todayDate })}`} className="outline-button">Today</Link>
          <Link href={`/admin/calendar?${buildQuery(raw, { date: nextDate })}`} className="outline-button">Next →</Link>
        </div>
        <div className="cal-nav-label">
          {anchorDateStr} · {view} view · columns in {filteredLocation ? `${filteredLocation.name}'s timezone (${referenceTimezone})` : `the business timezone (${businessTimezone})`}
        </div>
      </div>

      {vehicles.length === 0 ? (
        <EmptyState
          heading={conflictsOnly ? "No conflicts or overdue returns" : "No vehicles match these filters"}
          description={conflictsOnly ? "Nothing needs attention in this window." : "Try widening the location or category filters."}
        />
      ) : (
        <Card>
          <div className="cal-grid-wrap">
            <div className="cal-grid" style={{ gridTemplateColumns: `160px repeat(${columns.length}, minmax(${view === "month" ? 28 : 60}px, 1fr))` }}>
              <div className="cal-corner" />
              {columns.map((c) => (
                <div key={c.key} className="cal-col-header">{c.label}</div>
              ))}

              {Array.from(groups.entries()).map(([groupName, rows]) => (
                <div key={groupName} className="cal-group" style={{ gridColumn: `1 / span ${columns.length + 1}` }}>
                  <div className="cal-group-heading">{groupName}</div>
                  {rows.map((row) => (
                    <div key={row.vehicleId} className="cal-row" style={{ gridTemplateColumns: `160px 1fr` }}>
                      <div className="cal-row-label">
                        <Link href={`/admin/fleet/${row.vehicleId}`}>{row.make} {row.model}</Link>
                        <small>{row.plateNumber}</small>
                      </div>
                      <div className="cal-track">
                        {view === "day" && nowPct !== null && (
                          <span className="cal-now-line" style={{ left: `${nowPct}%` }} />
                        )}
                        {row.blocks.map((b) => renderBar(b, row.vehicleId, winStart, winEnd, b.id))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {totalVehicleCount > ROW_LIMIT && (
            <div className="admin-pagination cal-pagination">
              <span>{page * ROW_LIMIT + 1}–{Math.min(totalVehicleCount, (page + 1) * ROW_LIMIT)} of {totalVehicleCount} vehicles</span>
              {page > 0 && (
                <Link href={`/admin/calendar?${buildQuery(raw, { page: String(page - 1) })}`} className="outline-button">← Prev rows</Link>
              )}
              {(page + 1) * ROW_LIMIT < totalVehicleCount && (
                <Link href={`/admin/calendar?${buildQuery(raw, { page: String(page + 1) })}`} className="outline-button">Next rows →</Link>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  );
}
