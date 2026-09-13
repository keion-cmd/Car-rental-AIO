import { requireAuth } from "../../lib/auth/guard";
import { PageHeader } from "../components/admin/PageHeader";
import { EmptyState } from "../components/admin/EmptyState";

export const dynamic = "force-dynamic";

// Lowest role in the hierarchy — every signed-in staff account reaches
// Overview. Each admin route calls requireAuth independently; the sidebar
// hiding a link is UX, this call is the actual gate.
export default async function AdminOverviewPage() {
  await requireAuth("STAFF");

  return (
    <>
      <PageHeader title="Overview" description="A daily snapshot of what needs attention across the fleet." />
      <EmptyState
        heading="No data yet"
        description="Once bookings, fleet and payment activity are wired up, this page will summarize what needs attention today."
      />
    </>
  );
}
