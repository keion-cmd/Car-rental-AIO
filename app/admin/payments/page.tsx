import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminPaymentsPage() {
  await requireAuth("MANAGER");

  return (
    <>
      <PageHeader title="Payments" description="Deposits, balances due and refunds across bookings." />
      <EmptyState
        heading="No payment activity yet"
        description="This will queue outstanding balances and refund requests with one action per row."
      />
    </>
  );
}
