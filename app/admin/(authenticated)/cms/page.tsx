import { requireAuth } from "../../../../lib/auth/guard";
import { PageHeader } from "../../../components/admin/PageHeader";
import { EmptyState } from "../../../components/admin/EmptyState";

export const dynamic = "force-dynamic";

// Placeholder only — content management is built in P7.
export default async function AdminCmsPage() {
  await requireAuth("ADMIN");

  return (
    <>
      <PageHeader title="CMS" description="Public site content: pages, copy and imagery." />
      <EmptyState
        heading="Content management is not built yet"
        description="This section will let admins edit public site copy and imagery. Built in P7."
      />
    </>
  );
}
