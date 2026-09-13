import type { ReactNode } from "react";

export function EmptyState({
  icon,
  heading,
  description,
  action,
}: {
  icon?: ReactNode;
  heading: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="admin-empty-state">
      {icon && <div className="admin-empty-state-icon">{icon}</div>}
      <h2>{heading}</h2>
      <p>{description}</p>
      {action && <div className="admin-empty-state-action">{action}</div>}
    </div>
  );
}
