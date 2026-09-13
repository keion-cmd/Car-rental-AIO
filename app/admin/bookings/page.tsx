import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminBookingsPage() {
  await requireAuth("STAFF");

  return (
    <>
      <PageHeader title="Bookings" description="The reservation queue: pending, confirmed, ongoing and completed." />
      <EmptyState
        heading="No bookings queue yet"
        description="This will list reservations grouped by status with counts and a quick action per row. Built in P5."
      />
    </>
  );
}
