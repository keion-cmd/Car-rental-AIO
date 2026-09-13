import { requireAuth } from "../../../lib/auth/guard";
import { PageHeader } from "../../components/admin/PageHeader";
import { EmptyState } from "../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  await requireAuth("OWNER");

  return (
    <>
      <PageHeader title="Settings" description="Company-wide configuration." />
      <EmptyState
        heading="No settings yet"
        description="This will hold company-wide configuration: business hours, policies and integrations."
      />
    </>
  );
}
