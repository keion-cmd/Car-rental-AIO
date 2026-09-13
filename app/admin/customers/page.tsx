import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  await requireAuth("MANAGER");

  return (
    <>
      <PageHeader title="Customers" description="Renter profiles, contact details and rental history." />
      <EmptyState
        heading="No customer records yet"
        description="This will list renters with their booking history and any flags on their account."
      />
    </>
  );
}
