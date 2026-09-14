import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireAuth("OWNER");

  return (
    <>
      <PageHeader title="Audit" description="Who changed what, and when." />
      <EmptyState
        heading="No audit log yet"
        description="This will list changes to bookings, pricing and settings with the acting user and timestamp."
      />
    </>
  );
}
