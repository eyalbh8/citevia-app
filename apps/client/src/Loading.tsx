import './loading.css';

type SkeletonVariant =
  | 'dashboard'
  | 'table'
  | 'cards'
  | 'form'
  | 'detail'
  | 'chart'
  | 'workspace';

function Line({ className = '' }: { className?: string }) {
  return <span className={`skeleton-shape skeleton-line ${className}`} />;
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="skeleton-panel skeleton-table">
      <div className="skeleton-table-heading">
        <Line className="skeleton-width-medium" />
        <Line className="skeleton-width-short" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-table-row" key={index}>
          <span className="skeleton-shape skeleton-avatar" />
          <div className="skeleton-copy">
            <Line className={index % 2 ? 'skeleton-width-medium' : ''} />
            <Line className="skeleton-width-short skeleton-line-small" />
          </div>
          <span className="skeleton-shape skeleton-pill" />
          <Line className="skeleton-cell" />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="skeleton-panel skeleton-chart">
      <Line className="skeleton-width-medium" />
      <Line className="skeleton-width-short skeleton-line-small" />
      <div className="skeleton-chart-plot">
        {[38, 54, 45, 70, 58, 82, 72, 92, 80, 96].map((height, index) => (
          <span
            key={index}
            className="skeleton-shape skeleton-chart-bar"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function DashboardSkeleton({ rows }: { rows: number }) {
  return (
    <>
      <div className="skeleton-metrics">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="skeleton-panel skeleton-metric" key={index}>
            <Line className="skeleton-width-medium" />
            <span className="skeleton-shape skeleton-value" />
            <Line className="skeleton-line-small" />
          </div>
        ))}
      </div>
      <div className="skeleton-chart-grid">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
      <TableSkeleton rows={rows} />
    </>
  );
}

/** A stable content outline while the initial request is in flight. */
export function Skeleton({
  variant = 'table',
  label = 'Loading your workspace…',
  rows = 5,
}: {
  variant?: SkeletonVariant;
  label?: string;
  rows?: number;
}) {
  const count = Math.max(1, Math.min(12, rows));
  return (
    <div className={`content-skeleton content-skeleton-${variant}`} role="status" aria-live="polite" aria-label={label}>
      <div className="skeleton-visual" aria-hidden="true">
        {variant === 'workspace' && (
          <div className="skeleton-page-heading">
            <Line className="skeleton-title" />
            <Line className="skeleton-width-medium" />
          </div>
        )}
        {(variant === 'dashboard' || variant === 'workspace') && <DashboardSkeleton rows={count} />}
        {variant === 'table' && <TableSkeleton rows={count} />}
        {variant === 'chart' && <ChartSkeleton />}
        {variant === 'cards' && (
          <div className="skeleton-card-grid">
            {Array.from({ length: Math.min(count, 6) }, (_, index) => (
              <div className="skeleton-panel skeleton-card" key={index}>
                <div className="skeleton-card-heading">
                  <span className="skeleton-shape skeleton-avatar skeleton-avatar-large" />
                  <div className="skeleton-copy">
                    <Line />
                    <Line className="skeleton-width-medium skeleton-line-small" />
                  </div>
                </div>
                <Line />
                <Line className="skeleton-width-medium" />
                <span className="skeleton-shape skeleton-pill" />
              </div>
            ))}
          </div>
        )}
        {variant === 'form' && (
          <div className="skeleton-panel skeleton-form">
            <Line className="skeleton-title" />
            <Line className="skeleton-width-medium" />
            <div className="skeleton-fields">
              {Array.from({ length: count }, (_, index) => (
                <div className="skeleton-field" key={index}>
                  <Line className="skeleton-width-short skeleton-line-small" />
                  <span className="skeleton-shape skeleton-input" />
                </div>
              ))}
            </div>
            <span className="skeleton-shape skeleton-button" />
          </div>
        )}
        {variant === 'detail' && (
          <div className="skeleton-panel skeleton-detail">
            <Line className="skeleton-title" />
            <div className="skeleton-detail-tags">
              <span className="skeleton-shape skeleton-pill" />
              <span className="skeleton-shape skeleton-pill" />
            </div>
            {Array.from({ length: count }, (_, index) => (
              <div className="skeleton-paragraph" key={index}>
                <Line /><Line /><Line className="skeleton-width-medium" />
              </div>
            ))}
          </div>
        )}
      </div>
      <span className="skeleton-caption" aria-hidden="true">{label}</span>
    </div>
  );
}
