import { requireAuth, roleSatisfies } from "../../lib/auth/guard";
import { PageHeader } from "../components/admin/PageHeader";
import { getDashboardSummary } from "../../lib/services/dashboard.service";
import { formatMoney } from "../../lib/money";
import Link from "next/link";

export const dynamic = "force-dynamic";

const FLEET_STATUS_ORDER = ["AVAILABLE", "RENTED", "RESERVED", "MAINTENANCE", "BLOCKED"] as const;
const FLEET_STATUS_LABEL: Record<(typeof FLEET_STATUS_ORDER)[number], string> = {
  AVAILABLE: "Available",
  RENTED: "Rented",
  RESERVED: "Reserved",
  MAINTENANCE: "Maintenance",
  BLOCKED: "Blocked",
};

function formatShortDate(dateKey: string): string {
  // dateKey is a YYYY-MM-DD calendar string, not a UTC instant — parsed as
  // UTC here purely to format it, never compared against a real instant.
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

// Lowest role in the hierarchy — every signed-in staff account reaches
// Overview. Each admin route calls requireAuth independently; the sidebar
// hiding a link is UX, this call is the actual gate.
export default async function AdminOverviewPage() {
  const user = await requireAuth("STAFF");
  const canSeeMoney = roleSatisfies(user.role, "MANAGER");

  const now = new Date();
  const summary = await getDashboardSummary(now, undefined, canSeeMoney);

  const totalActive = summary.fleetStatus.totalActive;

  return (
    <>
      <PageHeader title="Overview" description="What needs a human today." />

      <div className="dash-section">
        <div className="dash-queue-grid">
          <Link
            href={summary.actionQueues.overdue.href}
            className={`dash-queue-card dash-queue-card-overdue${summary.actionQueues.overdue.count === 0 ? " dash-queue-card-zero" : ""}`}
          >
            <div className="dash-queue-count">{summary.actionQueues.overdue.count}</div>
            <div className="dash-queue-label">Overdue returns</div>
          </Link>
          <Link
            href={summary.actionQueues.pickupsToday.href}
            className={`dash-queue-card${summary.actionQueues.pickupsToday.count === 0 ? " dash-queue-card-zero" : ""}`}
          >
            <div className="dash-queue-count">{summary.actionQueues.pickupsToday.count}</div>
            <div className="dash-queue-label">Pickups today</div>
          </Link>
          <Link
            href={summary.actionQueues.returnsToday.href}
            className={`dash-queue-card${summary.actionQueues.returnsToday.count === 0 ? " dash-queue-card-zero" : ""}`}
          >
            <div className="dash-queue-count">{summary.actionQueues.returnsToday.count}</div>
            <div className="dash-queue-label">Returns today</div>
          </Link>
          <Link
            href={summary.actionQueues.pendingConfirmation.href}
            className={`dash-queue-card${summary.actionQueues.pendingConfirmation.count === 0 ? " dash-queue-card-zero" : ""}`}
          >
            <div className="dash-queue-count">{summary.actionQueues.pendingConfirmation.count}</div>
            <div className="dash-queue-label">Pending confirmation</div>
          </Link>
          <Link
            href={summary.actionQueues.paymentFailed.href}
            className={`dash-queue-card${summary.actionQueues.paymentFailed.count === 0 ? " dash-queue-card-zero" : ""}`}
          >
            <div className="dash-queue-count">{summary.actionQueues.paymentFailed.count}</div>
            <div className="dash-queue-label">Payment failed</div>
          </Link>
        </div>
      </div>

      <div className="dash-section">
        <h2>Fleet status</h2>
        {totalActive === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>No active vehicles in the fleet.</p>
        ) : (
          <>
            <div className="dash-fleet-bar">
              {FLEET_STATUS_ORDER.map((status) => {
                const count = summary.fleetStatus.counts[status];
                if (count === 0) return null;
                const pct = (count / totalActive) * 100;
                return (
                  <Link
                    key={status}
                    href={`/admin/fleet?status=${status}`}
                    className={`dash-fleet-segment dash-fleet-segment-${status}`}
                    style={{ width: `${pct}%` }}
                    title={`${FLEET_STATUS_LABEL[status]}: ${count}`}
                  >
                    {pct >= 8 ? count : ""}
                  </Link>
                );
              })}
            </div>
            <div className="dash-fleet-legend">
              {FLEET_STATUS_ORDER.map((status) => (
                <span key={status} className="dash-fleet-legend-item">
                  <span className={`dash-fleet-dot dash-fleet-segment-${status}`} />
                  <Link href={`/admin/fleet?status=${status}`}>{summary.fleetStatus.counts[status]}</Link>
                  {FLEET_STATUS_LABEL[status]}
                </span>
              ))}
              <span className="dash-fleet-legend-item">{totalActive} active vehicles total</span>
            </div>
          </>
        )}
      </div>

      {summary.money && (
        <div className="dash-section">
          <h2>Money</h2>
          <div className="dash-money-grid">
            <div className="dash-money-card">
              <div className="dash-money-value">{formatMoney(summary.money.revenueToday, summary.money.currency)}</div>
              <div className="dash-money-label">Revenue today</div>
            </div>
            <div className="dash-money-card">
              <div className="dash-money-value">{formatMoney(summary.money.revenueThisWeek, summary.money.currency)}</div>
              <div className="dash-money-label">Revenue this week</div>
            </div>
            <div className="dash-money-card">
              <div className="dash-money-value">{formatMoney(summary.money.revenueThisMonth, summary.money.currency)}</div>
              <div className="dash-money-label">Revenue this month</div>
            </div>
            <div className="dash-money-card">
              <div className="dash-money-value">{formatMoney(summary.money.outstandingBalance, summary.money.currency)}</div>
              <div className="dash-money-label">Outstanding balance</div>
            </div>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>
            Security deposits are excluded from every figure above.
          </p>
        </div>
      )}

      <div className="dash-section">
        <h2>Next seven days</h2>
        <div className="dash-week-strip">
          {summary.nextSevenDays.map((day) => (
            <div key={day.date} className="dash-week-day">
              <div className="dash-week-date">{formatShortDate(day.date)}</div>
              <div className="dash-week-counts">
                <span title="Pickups">▲ {day.pickups}</span>
                <span title="Returns">▼ {day.returns}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-section">
        <h2>Recent activity</h2>
        {summary.recentActivity.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>No bookings yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentActivity.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/bookings/${row.id}`}>{row.reference}</Link>
                    </td>
                    <td>{row.customerName}</td>
                    <td>{row.vehicleLabel}</td>
                    <td>{row.status}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
