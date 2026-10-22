import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ArrowDownRight,
  ArrowDownToLine,
  ArrowUpRight,
  Info,
  Minus,
} from 'lucide-react';
import {
  PROVIDER_LABELS,
  projectProviders,
  type DashboardOverview,
  type Project,
} from '@citevia/core';
import { downloadCsv, useApi } from './api';
import { Empty, ErrorNotice, formatNumber, labelize } from './components';
import { Skeleton } from './Loading';
import DomainLogo from './DomainLogo';
import {
  initialSelection,
  MonitoringHeader,
  ProviderMark,
  selectionQuery,
  type MonitorSelection,
} from './MonitoringUI';
import './dashboard.css';

const brandColors = ['#3930cf', '#148a91', '#b27621', '#ad537d', '#7685ce'];
const stageColors: Record<string, string> = {
  understand: '#7685ce',
  prefer: '#3930cf',
  trust: '#148a91',
  convert: '#b27621',
  unassigned: '#70778c',
};
const dayLabel = (date: string, full = false) =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    ...(full ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  });

function Change({
  value,
  unit = '%',
  label,
}: {
  value: number | null;
  unit?: string;
  label: string;
}) {
  const Icon =
    value === null || value === 0
      ? Minus
      : value > 0
        ? ArrowUpRight
        : ArrowDownRight;
  const shown =
    value === null ? '—' : `${formatNumber(Math.abs(value), 1)}${unit}`;
  return (
    <span
      className={`overview-change ${value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : 'neutral'}`}
      title={`${label}: ${value === null ? 'no comparison available' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${shown}`}`}
    >
      {value !== null && <Icon size={12} aria-hidden="true" />}
      <span className="visually-hidden">
        {label}:{' '}
        {value === null
          ? 'not available'
          : value > 0
            ? 'increased by '
            : value < 0
              ? 'decreased by '
              : 'unchanged, '}
      </span>
      <span aria-hidden={value === null || undefined}>{shown}</span>
    </span>
  );
}

function exportOverview(data: DashboardOverview, name: string) {
  const rows: (string | number | null)[][] = [];
  const add = (
    section: string,
    item: string,
    metric: string,
    value: string | number | null,
  ) => rows.push([section, item, metric, value]);
  add('Period', name, 'Start (UTC)', data.period.start);
  add('Period', name, 'End (UTC)', data.period.end);
  for (const [key, value] of Object.entries(data.filters))
    if (
      Array.isArray(value) ? value.length : value !== '' && value !== undefined
    )
      add(
        'Filter',
        name,
        key,
        Array.isArray(value) ? value.join(', ') : String(value),
      );
  for (const p of data.providers) {
    add('Providers', PROVIDER_LABELS[p.provider], 'Mentions', p.count);
    add('Providers', PROVIDER_LABELS[p.provider], 'Change (%)', p.change);
  }
  for (const s of data.stages) {
    add('Stages', labelize(s.key), 'Visibility (%)', s.visibility);
    add('Stages', labelize(s.key), 'Active prompts', s.promptCount);
    add('Stages', labelize(s.key), 'Measured prompts', s.measuredPromptCount);
  }
  for (const b of data.ranking) {
    add('Industry ranking', b.name, 'Average daily rank', b.rank);
    add('Industry ranking', b.name, 'Rank improvement', b.rankChange);
    add('Industry ranking', b.name, 'Mentions', b.mentions);
    add('Industry ranking', b.name, 'Mention change (%)', b.mentionChange);
    add('Industry ranking', b.name, 'Sentiment (0–100)', b.sentiment);
    add(
      'Industry ranking',
      b.name,
      'Sentiment change (points)',
      b.sentimentChange,
    );
  }
  for (const d of data.trend)
    for (const b of data.ranking)
      rows.push(['Daily mentions', b.name, d.date, d.mentions[b.brandId] ?? 0]);
  for (const s of data.sources) {
    add('Sources', s.domain, 'Distinct pages', s.pageCount);
    add('Sources', s.domain, 'Citations', s.citationCount);
  }
  downloadCsv(
    `citevia-dashboard-${data.period.start.slice(0, 10)}-${data.period.end.slice(0, 10)}.csv`,
    ['Section', 'Name', 'Metric', 'Value'],
    rows,
  );
}

export function DashboardView({
  project,
  path,
  actions,
}: {
  project: Project;
  path: string;
  actions?: ReactNode;
}) {
  const [selection, setSelection] =
    useState<MonitorSelection>(() => initialSelection('7', project.demo));
  const [retry, setRetry] = useState(0);
  const overview = useApi<DashboardOverview>(
    `${path}/dashboard/overview${selectionQuery(selection)}`,
    retry,
  );
  const data = overview.data;
  const periodCaption =
    selection.days === 'custom'
      ? 'Mentions in the selected period'
      : selection.days === '1'
        ? 'Mentions in the last 24 hours'
        : `Mentions in the last ${selection.days} days`;
  const missingPrompts =
    data?.stages.reduce(
      (sum, stage) => sum + stage.promptCount - stage.measuredPromptCount,
      0,
    ) || 0;
  return (
    <div className="monitor-screen dashboard-screen">
      <MonitoringHeader
        title="Dashboard"
        project={project}
        value={selection}
        onChange={setSelection}
        actions={
          <>
            <button
              className="button button-outline"
              onClick={() => data && exportOverview(data, project.brand.name)}
              disabled={!data || overview.loading || !!overview.error}
            >
              <ArrowDownToLine size={14} />
              Export
            </button>
            {actions}
          </>
        }
      />
      <ErrorNotice
        error={overview.error}
        retry={() => setRetry((value) => value + 1)}
      />
      {overview.loading && !data ? (
        <OverviewSkeleton
          providers={
            selection.providers.length || projectProviders(project).length
          }
        />
      ) : (
        data && (
          <div className="overview-content" aria-busy={overview.loading}>
            <div className="overview-period-note">
              <span>
                {dayLabel(data.period.start)} –{' '}
                {dayLabel(data.period.end, true)}{' '}
                <span className="overview-timezone">UTC</span>
              </span>
              <span role="status">
                {overview.loading
                  ? 'Updating results…'
                  : overview.error
                    ? 'Showing the last loaded results'
                    : `${formatNumber(data.analyzed)} analyzed answers`}
              </span>
            </div>
            {!data.analyzed && (
              <div className="overview-empty-note" role="status">
                <Info size={16} />
                <span>
                  No analyzed answers in this period. Adjust the filters or run
                  a scan to collect results.
                </span>
              </div>
            )}
            <section className="overview-providers" aria-label="LLM mentions">
              {data.providers.map((p) => (
                <article className="overview-provider card" key={p.provider}>
                  <h2>
                    <ProviderMark provider={p.provider} />
                    {PROVIDER_LABELS[p.provider]}
                  </h2>
                  <div className="overview-provider-value">
                    <strong>{formatNumber(p.count)}</strong>
                    <Change
                      value={p.change}
                      label="Change from first to last observed day"
                    />
                  </div>
                  <p>{periodCaption}</p>
                </article>
              ))}
            </section>
            <section
              className="card overview-stages"
              aria-labelledby="stage-title"
            >
              <div className="card-header">
                <div>
                  <h2 className="card-title" id="stage-title">
                    Visibility by stage
                  </h2>
                  <p className="card-description">
                    Average visibility per funnel stage
                  </p>
                </div>
              </div>
              {data.stages.length ? (
                <div className="overview-stage-list">
                  {data.stages.map((s) => (
                    <div
                      className="overview-stage"
                      key={s.key}
                      style={
                        {
                          '--stage-color':
                            stageColors[s.key] || stageColors.unassigned,
                        } as CSSProperties
                      }
                    >
                      <div className="overview-stage-heading">
                        <span className="overview-stage-name">
                          <i aria-hidden="true" />
                          {s.key === 'unassigned'
                            ? 'No stage'
                            : labelize(s.key)}
                          <span className="overview-prompt-count">
                            {formatNumber(s.promptCount)}{' '}
                            {s.promptCount === 1 ? 'prompt' : 'prompts'}
                          </span>
                        </span>
                        <strong>{formatNumber(s.visibility)}%</strong>
                      </div>
                      <div
                        className="overview-stage-track"
                        role="meter"
                        aria-label={`${s.key === 'unassigned' ? 'No stage' : labelize(s.key)} visibility`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={s.visibility}
                      >
                        <span
                          style={{
                            width: `${Math.max(0, Math.min(100, s.visibility))}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="No matching active prompts"
                  description="Stage visibility will appear when active prompts match these filters."
                />
              )}
              {missingPrompts > 0 && (
                <p className="overview-card-note">
                  {formatNumber(missingPrompts)} active{' '}
                  {missingPrompts === 1 ? 'prompt has' : 'prompts have'} no
                  results in this period and count as 0%.
                </p>
              )}
            </section>
            <div className="overview-comparison-grid">
              <section
                className="card overview-ranking"
                aria-labelledby="ranking-title"
              >
                <div className="card-header">
                  <div>
                    <h2 className="card-title" id="ranking-title">
                      Industry Ranking
                    </h2>
                    <p className="card-description">Top brands by visibility</p>
                  </div>
                  {project.role === 'owner' && !project.demo && (
                    <a
                      className="button button-quiet overview-manage-competitors"
                      href="#settings"
                    >
                      {project.competitors.length
                        ? 'Manage competitors'
                        : 'Add competitors'}
                    </a>
                  )}
                </div>
                {data.ranking.length ? (
                  <div
                    className="overview-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Industry ranking table"
                  >
                    <table className="overview-ranking-table">
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">Brand</th>
                          <th scope="col">
                            <abbr title="Average daily leaderboard position, based on brand mentions">
                              Rank
                            </abbr>
                          </th>
                          <th scope="col">Mentions</th>
                          <th scope="col">
                            <abbr title="Average sentiment across classified mentions in the selected period, from 0 to 100">
                              Sentiment
                            </abbr>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.ranking.map((b, index) => (
                          <tr
                            key={b.brandId}
                            className={b.isTarget ? 'is-target' : ''}
                          >
                            <td>{index + 1}</td>
                            <th scope="row">
                              <div className="overview-brand">
                                <DomainLogo
                                  domain={b.domain}
                                  name={b.name}
                                  className="overview-brand-avatar"
                                  style={
                                    {
                                      '--brand-color': brandColors[index],
                                    } as CSSProperties
                                  }
                                />
                                <span
                                  className="overview-brand-name"
                                  title={b.domain || b.name}
                                >
                                  {b.name}
                                  {b.isTarget && <small>Your brand</small>}
                                </span>
                              </div>
                            </th>
                            <td>
                              <div className="overview-measurement">
                                <strong>{formatNumber(b.rank, 1)}</strong>
                                <Change
                                  value={b.rankChange}
                                  unit=""
                                  label="Rank improvement from first to last observed day"
                                />
                              </div>
                            </td>
                            <td>
                              <div className="overview-measurement">
                                <strong>{formatNumber(b.mentions)}</strong>
                                <Change
                                  value={b.mentionChange}
                                  label="Mention change from first to last observed day"
                                />
                              </div>
                            </td>
                            <td>
                              <div className="overview-measurement">
                                <span
                                  className={`overview-sentiment ${b.sentiment === null ? '' : b.sentiment >= 70 ? 'positive' : b.sentiment < 40 ? 'negative' : 'neutral'}`}
                                  title={
                                    b.sentiment === null
                                      ? 'No classified sentiment in the selected period'
                                      : `${formatNumber(b.sentiment)} out of 100`
                                  }
                                >
                                  {formatNumber(b.sentiment)}
                                </span>
                                <Change
                                  value={b.sentimentChange}
                                  unit=" pts"
                                  label="Sentiment change from first to last observed day"
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="No brand mentions yet"
                    description="Brands will be ranked when your brand or a tracked competitor appears in an analyzed answer."
                  />
                )}
                {data.ranking.length > 0 && (
                  <div className="overview-card-footer">
                    <span>
                      {project.competitors.length
                        ? 'Rank reflects daily mention totals.'
                        : 'Add competitors to compare your brand with other companies.'}
                    </span>
                  </div>
                )}
              </section>
              <section
                className="card overview-trend"
                aria-labelledby="visibility-title"
              >
                <div className="card-header">
                  <div>
                    <h2 className="card-title" id="visibility-title">
                      Brand Visibility Over Time
                    </h2>
                    <p className="card-description">
                      Daily brand mentions compared with your competitors
                    </p>
                  </div>
                </div>
                {data.ranking.length && data.trend.length ? (
                  <BrandTrend ranking={data.ranking} points={data.trend} />
                ) : (
                  <Empty
                    title="Your visibility trend starts here"
                    description="Daily mentions will appear after a completed scan includes your brand or a competitor."
                  />
                )}
              </section>
            </div>
            <section
              className="card overview-sources"
              aria-labelledby="sources-title"
            >
              <div className="card-header">
                <div>
                  <h2 className="card-title" id="sources-title">
                    Sources
                  </h2>
                  <p className="card-description">
                    The domains most frequently cited in your responses
                  </p>
                </div>
              </div>
              {data.sources.length ? (
                <table className="overview-sources-table">
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">
                        <abbr title="Distinct cited URLs in the selected period">
                          Pages
                        </abbr>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.domain}>
                        <th scope="row">
                          <span className="overview-source">
                            <DomainLogo
                              domain={s.domain}
                              size={30}
                              className={`overview-source-icon ${s.owned ? 'owned' : ''}`}
                            />
                            <span className="overview-source-domain">
                              {s.domain}
                              {s.owned && <small>Your domain</small>}
                            </span>
                          </span>
                        </th>
                        <td>{formatNumber(s.pageCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty
                  title="No cited sources in this period"
                  description="Sources will appear when analyzed answers include citations. Try a wider date range or different filters."
                />
              )}
              {data.sources.length > 0 && (
                <p className="overview-card-note">
                  Top {data.sources.length} domains by citation frequency. Pages
                  counts distinct cited URLs.
                </p>
              )}
            </section>
          </div>
        )
      )}
    </div>
  );
}

function OverviewSkeleton({ providers }: { providers: number }) {
  return (
    <div
      className="overview-loading"
      role="status"
      aria-label="Loading dashboard results…"
    >
      <div className="overview-providers" aria-hidden="true">
        {Array.from({ length: providers }, (_, i) => (
          <div className="card overview-provider" key={i}>
            <span className="skeleton-shape skeleton-line skeleton-width-medium" />
            <span className="skeleton-shape skeleton-value" />
            <span className="skeleton-shape skeleton-line" />
          </div>
        ))}
      </div>
      <div className="card overview-stage-skeleton" aria-hidden="true">
        <span className="skeleton-shape skeleton-title" />
        {[75, 56, 38, 21].map((width) => (
          <div key={width}>
            <span className="skeleton-shape skeleton-line skeleton-width-short" />
            <span
              className="skeleton-shape skeleton-line"
              style={{ width: `${width}%`, maxWidth: 'none' }}
            />
          </div>
        ))}
      </div>
      <div className="overview-comparison-grid">
        <Skeleton variant="table" label="Loading brand rankings…" />
        <Skeleton variant="chart" label="Loading visibility history…" />
      </div>
    </div>
  );
}

function BrandTrend({
  ranking,
  points,
}: {
  ranking: DashboardOverview['ranking'];
  points: DashboardOverview['trend'];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartId = useId();
  const [width, setWidth] = useState(560);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, entry.contentRect.width)),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setActive(null), [points]);
  const height = 264,
    left = 40,
    right = width - 14,
    top = 20,
    bottom = 226;
  const times = points.map((p) =>
    Date.parse(`${p.date.slice(0, 10)}T12:00:00Z`),
  );
  const first = times[0],
    last = times.at(-1)!;
  const x = (i: number) =>
    first === last
      ? (left + right) / 2
      : left + ((times[i] - first) / (last - first)) * (right - left);
  const maximum = Math.max(
    1,
    ...points.flatMap((p) => ranking.map((b) => p.mentions[b.brandId] || 0)),
  );
  const step = Math.max(1, Math.ceil(maximum / 4));
  const ceiling = step * 4;
  const y = (count: number) => bottom - (count / ceiling) * (bottom - top);
  const tickCount = Math.min(width < 400 ? 3 : 5, points.length);
  const ticks = [
    ...new Set(
      Array.from({ length: tickCount }, (_, i) =>
        Math.round((i * (points.length - 1)) / Math.max(1, tickCount - 1)),
      ),
    ),
  ];
  const visibleActive =
    active === null ? null : Math.min(active, points.length - 1);
  const selected = visibleActive === null ? null : points[visibleActive];
  const activeDescription = selected
    ? `${dayLabel(selected.date, true)}. ${ranking.map((b) => `${b.name}: ${selected.mentions[b.brandId] || 0} mentions`).join('. ')}`
    : 'Use left and right arrow keys to explore daily mentions.';
  return (
    <div className="overview-trend-body">
      <div className="overview-chart-legend">
        {ranking.map((b, i) => (
          <span key={b.brandId}>
            <i style={{ background: brandColors[i] }} />
            {b.name}
          </span>
        ))}
      </div>
      <div
        className="overview-chart"
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label="Daily brand mentions chart"
        aria-describedby={`${chartId}-hint`}
        onFocus={() => setActive((value) => value ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (
            ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)
          ) {
            e.preventDefault();
            setActive((value) =>
              e.key === 'Escape'
                ? null
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? points.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          points.length - 1,
                          (value ?? points.length - 1) +
                            (e.key === 'ArrowLeft' ? -1 : 1),
                        ),
                      ),
            );
          }
        }}
        onPointerLeave={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label="Mention counts for the top brands on each observed day"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const pointerX =
              ((event.clientX - bounds.left) / bounds.width) * width;
            let index = 0;
            for (let i = 1; i < points.length; i++)
              if (Math.abs(x(i) - pointerX) < Math.abs(x(index) - pointerX))
                index = i;
            setActive(index);
          }}
        >
          {[0, 1, 2, 3, 4].map((n) => (
            <g key={n}>
              <line
                x1={left}
                x2={right}
                y1={y(n * step)}
                y2={y(n * step)}
                className="overview-gridline"
              />
              <text x={left - 9} y={y(n * step) + 4} textAnchor="end">
                {formatNumber(n * step)}
              </text>
            </g>
          ))}
          {ticks.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={bottom + 26}
              textAnchor={
                points.length === 1
                  ? 'middle'
                  : i === 0
                    ? 'start'
                    : i === points.length - 1
                      ? 'end'
                      : 'middle'
              }
            >
              {dayLabel(points[i].date)}
            </text>
          ))}
          {visibleActive !== null && (
            <line
              x1={x(visibleActive)}
              x2={x(visibleActive)}
              y1={top}
              y2={bottom}
              className="overview-active-line"
            />
          )}
          {ranking.map((b, i) => (
            <g key={b.brandId}>
              <polyline
                points={points
                  .map((p, j) => `${x(j)},${y(p.mentions[b.brandId] || 0)}`)
                  .join(' ')}
                fill="none"
                stroke={brandColors[i]}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.map((p, j) => (
                <circle
                  key={p.date}
                  cx={x(j)}
                  cy={y(p.mentions[b.brandId] || 0)}
                  r={visibleActive === j ? 5 : points.length === 1 ? 5 : 3}
                  fill={brandColors[i]}
                  stroke="white"
                  strokeWidth="1.5"
                >
                  <title>{`${b.name}, ${dayLabel(p.date)}: ${formatNumber(p.mentions[b.brandId] || 0)} mentions`}</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
        {selected && (
          <div
            className="overview-chart-tooltip"
            style={{
              left: Math.min(
                Math.max(10, x(visibleActive!) - 90),
                Math.max(10, width - 210),
              ),
            }}
            aria-hidden="true"
          >
            <strong>{dayLabel(selected.date, true)}</strong>
            {ranking.map((b, i) => (
              <span key={b.brandId}>
                <i style={{ background: brandColors[i] }} />
                {b.name}
                <b>{formatNumber(selected.mentions[b.brandId] || 0)}</b>
              </span>
            ))}
          </div>
        )}
        <span
          className="visually-hidden"
          id={`${chartId}-hint`}
          aria-live="polite"
        >
          {activeDescription}
        </span>
      </div>
      <details className="overview-chart-data">
        <summary>
          View daily data{' '}
          <span>
            {points.length} observed {points.length === 1 ? 'day' : 'days'} ·
            UTC
          </span>
        </summary>
        <div
          className="overview-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Daily mention values"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {ranking.map((b) => (
                  <th scope="col" key={b.brandId}>
                    {b.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date}>
                  <th scope="row">{dayLabel(p.date, true)}</th>
                  {ranking.map((b) => (
                    <td key={b.brandId}>
                      {formatNumber(p.mentions[b.brandId] || 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
