// Mirrors the shape of the eventual content (a header bar plus row blocks)
// so layout doesn't shift when real data replaces it — a spinner can't do
// that because it carries no dimensional information.
export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="admin-skeleton" aria-hidden="true">
      <div className="admin-skeleton-bar admin-skeleton-bar-wide" />
      {Array.from({ length: rows }).map((_, i) => (
        <div className="admin-skeleton-row" key={i}>
          <div className="admin-skeleton-bar" />
          <div className="admin-skeleton-bar admin-skeleton-bar-short" />
        </div>
      ))}
    </div>
  );
}
