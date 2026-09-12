import { z } from "zod";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h)");

// Wall-clock ordering check only (both fields are interpreted in the same
// timezone downstream), so this is a syntactic check we can run before any
// location lookup or service call — string comparison on same-format,
// same-timezone "YYYY-MM-DDTHH:MM" values is equivalent to chronological
// comparison.
export const searchParamsSchema = z
  .object({
    pickupLocationId: z.string().uuid(),
    dropoffLocationId: z.string().uuid().optional(),
    pickupDate: dateStr,
    pickupTime: timeStr,
    returnDate: dateStr,
    returnTime: timeStr,
  })
  .refine((v) => `${v.pickupDate}T${v.pickupTime}` < `${v.returnDate}T${v.returnTime}`, {
    message: "returnAt must be after pickupAt",
    path: ["returnDate"],
  });

export type SearchParams = z.infer<typeof searchParamsSchema>;
