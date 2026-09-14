"use server";

import { redirect } from "next/navigation";
import type { CustomerFlag } from "@prisma/client";
import { requireAuth } from "../../lib/auth/guard";
import { setCustomerFlag, clearCustomerFlag, updateStaffNotes } from "../../lib/services/customer.service";

const VALID_FLAGS: CustomerFlag[] = ["VIP", "REQUIRES_DEPOSIT", "BLACKLISTED"];

// This is PII, not counter-staff data — every write path here requires
// MANAGER, same gate as the page itself (lib/auth/guard.ts).
export async function setCustomerFlagAction(formData: FormData): Promise<void> {
  const user = await requireAuth("MANAGER");

  const customerId = String(formData.get("customerId") ?? "");
  const flagRaw = String(formData.get("flag") ?? "");
  const reason = String(formData.get("reason") ?? "");

  if (!customerId || !VALID_FLAGS.includes(flagRaw as CustomerFlag)) {
    redirect(`/admin/customers/${customerId}`);
  }

  const outcome = await setCustomerFlag(customerId, flagRaw as CustomerFlag, reason, user.id);
  if (!outcome.ok) {
    redirect(`/admin/customers/${customerId}?error=${outcome.reason.toLowerCase().replace(/_/g, "-")}`);
  }

  redirect(`/admin/customers/${customerId}`);
}

export async function clearCustomerFlagAction(formData: FormData): Promise<void> {
  const user = await requireAuth("MANAGER");

  const customerId = String(formData.get("customerId") ?? "");
  if (!customerId) {
    redirect("/admin/customers");
  }

  await clearCustomerFlag(customerId, user.id);
  redirect(`/admin/customers/${customerId}`);
}

export async function updateCustomerNotesAction(formData: FormData): Promise<void> {
  await requireAuth("MANAGER");

  const customerId = String(formData.get("customerId") ?? "");
  const notes = String(formData.get("notes") ?? "");

  if (!customerId) {
    redirect("/admin/customers");
  }

  await updateStaffNotes(customerId, notes);
  redirect(`/admin/customers/${customerId}`);
}
