import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminPricingPage() {
  await requireAuth("ADMIN");

  return (
    <>
      <PageHeader title="Pricing" description="Rate rules, seasonal adjustments and surcharges." />
      <EmptyState
        heading="No pricing rules yet"
        description="This will list rate rules and surcharges with the vehicles and dates they apply to."
      />
    </>
  );
}
