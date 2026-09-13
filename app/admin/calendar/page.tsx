import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminCalendarPage() {
  await requireAuth("STAFF");

  return (
    <>
      <PageHeader title="Calendar" description="Fleet availability across every vehicle, day by day." />
      <EmptyState
        heading="No calendar view yet"
        description="This will show vehicle availability, holds and maintenance blocks on a date grid."
      />
    </>
  );
}
