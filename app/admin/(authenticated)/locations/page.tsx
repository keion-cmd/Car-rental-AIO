import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  await requireAuth("ADMIN");

  return (
    <>
      <PageHeader title="Locations" description="Branches and pickup/drop-off points." />
      <EmptyState
        heading="No locations configured yet"
        description="This will list branches with their address, hours and assigned fleet."
      />
    </>
  );
}
