import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requireAuth("MANAGER");

  return (
    <>
      <PageHeader title="Reports" description="Utilization, revenue and fleet performance summaries." />
      <EmptyState
        heading="No reports yet"
        description="This will summarize utilization and revenue over a selectable date range."
      />
    </>
  );
}
