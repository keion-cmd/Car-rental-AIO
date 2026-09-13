"use client";

export function ErrorState({
  message,
  referenceId,
  onRetry,
}: {
  message: string;
  referenceId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="admin-error-state">
      <h2>Something went wrong</h2>
      <p>{message}</p>
      {referenceId && <p className="admin-error-reference">Reference: {referenceId}</p>}
      {onRetry && (
        <button type="button" className="outline-button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
