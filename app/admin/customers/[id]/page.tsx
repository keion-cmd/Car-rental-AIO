import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { Card } from "../../../components/admin/Card";
import { StatusBadge } from "../../../components/admin/StatusBadge";
import { formatMoney } from "../../../../lib/money";
import { getCurrency } from "../../../../lib/services/catalog.service";
import { getCustomerDetail } from "../../../../lib/services/customer-query.service";
import { setCustomerFlagAction, clearCustomerFlagAction, updateCustomerNotesAction } from "../../../actions/customers";

export const metadata: Metadata = {
  title: "Customer detail | Amihan Car Rentals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "long" }).format(date);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const FLAG_LABEL: Record<string, string> = {
  VIP: "VIP",
  REQUIRES_DEPOSIT: "Requires deposit",
  BLACKLISTED: "Blacklisted",
};

const FLAG_CLASS: Record<string, string> = {
  VIP: "admin-badge-blue",
  REQUIRES_DEPOSIT: "admin-badge-amber",
  BLACKLISTED: "admin-badge-red",
};

const ERROR_MESSAGES: Record<string, string> = {
  "flag-reason-required": "A reason is required to set a flag.",
};

export default async function AdminCustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // This is PII, not counter-staff data — STAFF may not see this screen.
  await requireAuth("MANAGER");
  const { id } = await params;
  const raw = await searchParams;
  const errorFlag = Array.isArray(raw.error) ? raw.error[0] : raw.error;

  const [detail, currency] = await Promise.all([getCustomerDetail(id), getCurrency()]);
  if (!detail) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={detail.name}
        description={`Customer since ${formatDate(detail.createdAt)}.`}
        action={<Link href="/admin/customers" className="outline-button">← Back to customers</Link>}
      />

      {errorFlag && (
        <div className="admin-error-state" style={{ marginBottom: 20 }}>
          <p>{ERROR_MESSAGES[errorFlag] ?? "Something went wrong."}</p>
        </div>
      )}

      {detail.flag && (
        <Card className="admin-status-header">
          <span className={`admin-badge ${FLAG_CLASS[detail.flag]}`}>{FLAG_LABEL[detail.flag]}</span>
          {detail.flag === "REQUIRES_DEPOSIT" && (
            <span className="admin-flag admin-flag-attention">Collect a deposit before handing over the keys</span>
          )}
          <span>
            {detail.flagReason} — set {detail.flaggedAt ? formatDate(detail.flaggedAt) : ""}
            {detail.flaggedBy ? ` by ${detail.flaggedBy.name}` : ""}
          </span>
        </Card>
      )}

      <div className="admin-detail-grid">
        <Card>
          <h2>Profile</h2>
          <dl className="admin-dl">
            <dt>Email</dt>
            <dd>{detail.email}</dd>
            <dt>Phone</dt>
            <dd>{detail.phone ?? "—"}</dd>
          </dl>
        </Card>

        <Card>
          <h2>Rental history summary</h2>
          <dl className="admin-dl">
            <dt>Total bookings</dt>
            <dd>{detail.totalBookings}</dd>
            <dt>Completed</dt>
            <dd>{detail.completedBookings}</dd>
            <dt>Cancelled</dt>
            <dd>{detail.cancelledBookings}</dd>
            <dt>Lifetime revenue</dt>
            <dd>{formatMoney(detail.lifetimeRevenue, currency)}</dd>
            <dt>Outstanding balance</dt>
            <dd>{formatMoney(detail.outstandingBalance, currency)}</dd>
          </dl>
        </Card>

        {detail.currentRental && (
          <Card>
            <h2>Current rental</h2>
            <dl className="admin-dl">
              <dt>Reference</dt>
              <dd><Link href={`/admin/bookings/${detail.currentRental.id}`}>{detail.currentRental.reference}</Link></dd>
              <dt>Vehicle</dt>
              <dd>{detail.currentRental.vehicleLabel}</dd>
              <dt>Pickup</dt>
              <dd>{formatDateTime(detail.currentRental.pickupAt)}</dd>
              <dt>Return</dt>
              <dd>{formatDateTime(detail.currentRental.returnAt)}</dd>
            </dl>
            {detail.currentRental.isOverdue && <span className="admin-flag admin-flag-overdue">Overdue</span>}
          </Card>
        )}

        <Card>
          <h2>Flag</h2>
          <form action={setCustomerFlagAction}>
            <input type="hidden" name="customerId" value={detail.id} />
            <select name="flag" defaultValue={detail.flag ?? ""} required>
              <option value="" disabled>Choose a flag</option>
              <option value="VIP">VIP</option>
              <option value="REQUIRES_DEPOSIT">Requires deposit</option>
              <option value="BLACKLISTED">Blacklisted</option>
            </select>
            <textarea name="reason" placeholder="Reason (required)" defaultValue={detail.flagReason ?? ""} required rows={3} style={{ width: "100%", marginTop: 10 }} />
            <button type="submit" className="outline-button" style={{ marginTop: 10 }}>Set flag</button>
          </form>
          {detail.flag && (
            <form action={clearCustomerFlagAction} style={{ marginTop: 10 }}>
              <input type="hidden" name="customerId" value={detail.id} />
              <button type="submit" className="outline-button">Clear flag</button>
            </form>
          )}
        </Card>

        <Card>
          <h2>Staff notes</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{detail.staffNotes ?? "No notes yet."}</p>
          <form action={updateCustomerNotesAction} style={{ marginTop: 10 }}>
            <input type="hidden" name="customerId" value={detail.id} />
            <textarea name="notes" defaultValue={detail.staffNotes ?? ""} rows={4} style={{ width: "100%" }} />
            <button type="submit" className="outline-button" style={{ marginTop: 10 }}>Save notes</button>
          </form>
        </Card>

        <Card>
          <h2>Booking history</h2>
          {detail.bookingHistory.length === 0 ? (
            <p>No bookings yet.</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table admin-table-compact">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th>Pickup</th>
                    <th>Return</th>
                    <th>Total</th>
                    <th>Balance due</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.bookingHistory.map((b) => (
                    <tr key={b.id}>
                      <td><Link href={`/admin/bookings/${b.id}`}>{b.reference}</Link></td>
                      <td><StatusBadge variant={b.status} /></td>
                      <td><StatusBadge variant={b.paymentStatus} /></td>
                      <td>{formatDate(b.pickupAt)}</td>
                      <td>{formatDate(b.returnAt)}</td>
                      <td>{formatMoney(b.totalAmount, b.currency)}</td>
                      <td>{formatMoney(b.balanceDue, b.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
