// Variants are the real enum values used by BookingStatus, PaymentStatus and
// BlockType in prisma/schema.prisma. The brief also asked for an OVERDUE
// (red) variant, but no OVERDUE value exists in any schema enum — inventing
// one is explicitly out of scope for this phase, so it is omitted here.
// Lateness is shown instead as a separate derived-flag badge by callers.
export type StatusBadgeVariant =
  | "PENDING"
  | "CONFIRMED"
  | "ONGOING"
  | "COMPLETED"
  | "CANCELLED"
  | "MAINTENANCE"
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "REFUNDED";

const VARIANT_CLASS: Record<StatusBadgeVariant, string> = {
  PENDING: "admin-badge-amber",
  CONFIRMED: "admin-badge-blue",
  ONGOING: "admin-badge-green",
  COMPLETED: "admin-badge-grey",
  CANCELLED: "admin-badge-grey-outline",
  MAINTENANCE: "admin-badge-purple",
  UNPAID: "admin-badge-amber",
  PARTIALLY_PAID: "admin-badge-blue",
  PAID: "admin-badge-green",
  REFUNDED: "admin-badge-grey-outline",
};

// Icons are plain glyphs, not an icon library — colour is never the only
// signal, each variant also has a distinct mark.
const VARIANT_ICON: Record<StatusBadgeVariant, string> = {
  PENDING: "○", // hollow circle
  CONFIRMED: "✓", // check
  ONGOING: "▶", // play
  COMPLETED: "■", // filled square
  CANCELLED: "✕", // cross
  MAINTENANCE: "⚙", // gear
  UNPAID: "○",
  PARTIALLY_PAID: "◐",
  PAID: "✓",
  REFUNDED: "↺",
};

export function StatusBadge({ variant, label }: { variant: StatusBadgeVariant; label?: string }) {
  return (
    <span className={`admin-badge ${VARIANT_CLASS[variant]}`}>
      <span className="admin-badge-icon" aria-hidden="true">
        {VARIANT_ICON[variant]}
      </span>
      {label ?? variant}
    </span>
  );
}
