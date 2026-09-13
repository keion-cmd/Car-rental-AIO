import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminFleetPage() {
  await requireAuth("STAFF");

  return (
    <>
      <PageHeader title="Fleet" description="Vehicles, their condition, and active maintenance blocks." />
      <EmptyState
        heading="No fleet list yet"
        description="This will list every vehicle with its current status and a link into its detail view."
      />
    </>
  );
}
