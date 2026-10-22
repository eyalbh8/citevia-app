import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Hexagon,
  Link2,
  Maximize2,
  TerminalSquare,
  X,
} from 'lucide-react';
import {
  PROVIDER_LABELS,
  type JourneyStage,
  type Project,
  type ScanProvider,
  type MentionAnswer,
  type MonitoringPeriod,
  type MentionsSummary,
} from '@citevia/core';
import { query } from './api';
import AnswerMarkdown from './AnswerMarkdown';
import DomainLogo from './DomainLogo';
import './monitoring.css';
import ProviderFilter from './ProviderFilter';
import DateRangeFilter, { initialDateRange } from './DateRangeFilter';
import FilterDropdown from './FilterDropdown';
import {
  brandingOptions,
  promptTypeOptions,
  regionOptions,
} from './filter-options';
export const providerColors: Record<ScanProvider, string> = {
  openai: '#000000',
  perplexity: '#22b8cd',
  gemini: '#3186ff',
};
export type MonitorSelection = {
  days: string;
  start: string;
  end: string;
  providers: ScanProvider[];
  region: string;
  branded: string;
  stage: JourneyStage | '';
};
export const initialSelection = (days = '7', demo?: Project['demo']): MonitorSelection => ({
  ...initialDateRange(demo),
  days: demo ? 'custom' : days,
  providers: [],
  region: '',
  branded: '',
  stage: '',
});
export function selectionQuery(
  s: MonitorSelection,
  extra: Record<string, string | number> = {},
) {
  return query({
    ...s,
    providers: s.providers.join(','),
    start: s.days === 'custom' ? s.start : undefined,
    end: s.days === 'custom' ? s.end : undefined,
    ...extra,
  });
}
export function MonitoringHeader({
  title,
  project,
  value,
  onChange,
  children,
  actions,
}: {
  title: string;
  project: Project;
  value: MonitorSelection;
  onChange: (s: MonitorSelection) => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const set = (key: keyof MonitorSelection, next: string) =>
    onChange({ ...value, [key]: next });
  return (
    <div className="monitor-filter-header">
      <h1>{title}</h1>
      {actions && <div className="monitor-header-actions">{actions}</div>}
      <div className="monitor-filters">
        <FilterDropdown
          label="Regions"
          icon={<Globe2 size={17} />}
          value={value.region}
          onChange={(v) => set('region', v)}
          placeholder="Regions"
          options={regionOptions(project.country)}
        />
        <FilterDropdown
          label="Branded"
          icon={<Hexagon size={17} />}
          value={value.branded}
          onChange={(v) => set('branded', v)}
          placeholder="Branded"
          options={brandingOptions}
        />
        <FilterDropdown
          label="Prompt Types"
          icon={<TerminalSquare size={17} />}
          value={value.stage}
          onChange={(v) => set('stage', v)}
          placeholder="Prompt Types"
          options={promptTypeOptions}
        />
        <ProviderFilter
          project={project}
          value={value.providers}
          onChange={(providers) => onChange({ ...value, providers })}
          multiple
        />
        <DateRangeFilter
          value={value}
          onChange={(range) => onChange({ ...value, ...range })}
          demo={project.demo}
        />
        {children}
      </div>
    </div>
  );
}
export function ProviderMark({ provider }: { provider: ScanProvider }) {
  return (
    <span className={`provider-mark ${provider}`} aria-hidden="true">
      <img src={`/providers/${provider}.svg`} alt="" width="22" height="22" />
    </span>
  );
}
export function ProviderDonut({ summary }: { summary: MentionsSummary }) {
  const [hover, setHover] = useState<ScanProvider>();
  const r = 84,
    c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <section className="monitor-card mentions-donut">
      <h2>LLM Mentions</h2>
      <div className="donut-body">
        <svg
          viewBox="0 0 240 240"
          role="img"
          aria-label={`${summary.total} total mentions`}
        >
          <circle
            cx="120"
            cy="120"
            r={r}
            fill="none"
            stroke="var(--primary-soft)"
            strokeWidth="30"
          />
          {summary.providers
            .filter((p) => p.count)
            .map((p) => {
              const arc = (p.count / summary.total) * c,
                start = offset;
              offset += arc;
              return (
                <circle
                  key={p.provider}
                  cx="120"
                  cy="120"
                  r={r}
                  fill="none"
                  stroke={providerColors[p.provider]}
                  strokeWidth="30"
                  strokeDasharray={`${Math.max(0, arc - 1)} ${c}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 120 120)"
                  tabIndex={0}
                  onMouseEnter={() => setHover(p.provider)}
                  onMouseLeave={() => setHover(undefined)}
                  onFocus={() => setHover(p.provider)}
                  onBlur={() => setHover(undefined)}
                >
                  <title>
                    {`${PROVIDER_LABELS[p.provider]}: ${p.count} mentions (${p.share}%)`}
                  </title>
                </circle>
              );
            })}
          <text x="120" y="115" textAnchor="middle" className="donut-label">
            Total Mentions
          </text>
          <text x="120" y="144" textAnchor="middle" className="donut-total">
            {summary.total.toLocaleString()}
          </text>
        </svg>
        <div className="donut-provider-icons">
          {summary.providers.map((p) => (
            <button
              key={p.provider}
              aria-label={`${PROVIDER_LABELS[p.provider]}: ${p.count} mentions, ${p.share}% share`}
              onMouseEnter={() => setHover(p.provider)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(p.provider)}
              onBlur={() => setHover(undefined)}
            >
              <ProviderMark provider={p.provider} />
            </button>
          ))}
        </div>
        {hover &&
          (() => {
            const p = summary.providers.find((p) => p.provider === hover)!;
            return (
              <div className="monitor-tooltip donut-tooltip">
                <strong>{PROVIDER_LABELS[hover]}</strong>
                <span>
                  Total mentions <b>{p.count}</b>
                </span>
                <span>
                  Share <b>{p.share}%</b>
                </span>
                <span title="First to last observed day in this range">
                  Change{' '}
                  <b
                    className={
                      p.change === null
                        ? ''
                        : p.change >= 0
                          ? 'improved'
                          : 'declined'
                    }
                  >
                    {p.change === null
                      ? '—'
                      : `${p.change > 0 ? '+' : ''}${p.change.toFixed(2)}%`}
                  </b>
                </span>
              </div>
            );
          })()}
      </div>
    </section>
  );
}
function buckets(period: MonitoringPeriod) {
  const step = period.granularity === 'hourly' ? 3600000 : 86400000;
  const start = new Date(period.start);
  if (step === 3600000) start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  return Array.from(
    {
      length: Math.ceil((Date.parse(period.end) - start.getTime() + 1) / step),
    },
    (_, i) => {
      const at = new Date(start.getTime() + i * step).toISOString();
      return step === 3600000 ? at : at.slice(0, 10);
    },
  );
}
function MentionPoint({ provider }: { provider: ScanProvider }) {
  // Nested sizes keep every provider visible when measurements coincide.
  if (provider === 'openai') return <circle r="3.5" />;
  if (provider === 'gemini') return <path d="M0,-2.8 L2.8,0 L0,2.8 L-2.8,0 Z" />;
  return <rect x="-1.4" y="-1.4" width="2.8" height="2.8" />;
}

type PublicationMarker = MentionsSummary['markers'][number];

function TrackedPublicationMarker({
  marker,
  left,
  label,
  open,
  onToggle,
  onClose,
  onTracked,
}: {
  marker: PublicationMarker;
  left: number;
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onTracked: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const popupId = `tracked-publications-${marker.date.replace(/\W/g, '')}`;
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = buttonRef.current!.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const above = bounds.top >= 220;
      setPosition({
        width,
        left: Math.max(
          12,
          Math.min(bounds.left + bounds.width / 2 - width / 2, window.innerWidth - width - 12),
        ),
        top: above ? bounds.top - 10 : bounds.bottom + 10,
        maxHeight: Math.max(
          120,
          Math.min(360, above ? bounds.top - 22 : window.innerHeight - bounds.bottom - 22),
        ),
        transform: above ? 'translateY(-100%)' : undefined,
      });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) {
        onClose();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      buttonRef.current?.focus();
    };
    place();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, onClose]);
  return (
    <div
      ref={ref}
      className="chart-publication-marker"
      style={{ left: `${left}%` }}
    >
      <button
        ref={buttonRef}
        className="chart-publication-badge"
        aria-label={`${marker.items.length} tracked URLs on ${label}`}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={onToggle}
      >
        <Link2 size={12} aria-hidden="true" />
        {marker.items.length}
      </button>
      {open && position && (
        <div
          id={popupId}
          className="marker-tooltip"
          role="dialog"
          aria-label={`Tracked URLs on ${label}`}
          style={position}
        >
          <header>
            <div>
              <strong>Tracked content</strong>
              <small>{label} · {marker.items.length} URLs</small>
            </div>
            <button
              aria-label="Close tracked content"
              onClick={() => {
                onClose();
                buttonRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </header>
          <ul className="marker-content-list" aria-label="Tracked URL citation counts">
            {marker.items.map((item) => {
              const contentType = item.contentType;
              const imageUrl = item.imageUrl;
              const published = item.publishedAt ?? marker.date;
              return (
                <li key={item.id}>
                  <button
                    className="marker-content-card"
                    aria-label={`Open tracking details for ${item.title}`}
                    onClick={() => {
                      onClose();
                      onTracked(item.id);
                    }}
                  >
                    <span className="marker-content-meta">
                      <span>
                        <DomainLogo domain={item.url} size={19} />
                        {contentType === 'BLOG'
                          ? 'Blog'
                          : contentType === 'SOCIAL'
                            ? 'Social post'
                            : contentType === 'WEBSITE'
                              ? 'Website'
                              : 'Tracked URL'}
                      </span>
                      <time dateTime={published}>
                        {new Date(published).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </time>
                    </span>
                    {imageUrl && (
                      <img
                        className="marker-content-image"
                        src={imageUrl}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <strong>{item.title}</strong>
                    <small className="marker-content-url">
                      {item.url.replace(/^https?:\/\//, '')}
                    </small>
                    <span
                      className="marker-content-citations"
                      title="Source appearances in the selected period"
                    >
                      Cited: <b>{item.appearances.toLocaleString()}</b>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
function ExpandedChart({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="chart-expanded"
      aria-label="Mentions over time"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
export function MentionsChart({
  summary,
  onTracked,
}: {
  summary: MentionsSummary;
  onTracked: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false),
    [hover, setHover] = useState<number>(),
    [hidden, setHidden] = useState<ScanProvider[]>([]),
    [openMarker, setOpenMarker] = useState<string>();
  const dates = buckets(summary.period),
    visible = summary.providers.filter((p) => !hidden.includes(p.provider));
  const markerGroups = new Map<string, Map<string, PublicationMarker['items'][number]>>();
  for (const marker of summary.markers) {
    const date = summary.period.granularity === 'hourly'
      ? `${marker.date.slice(0, 13)}:00:00.000Z`
      : marker.date.slice(0, 10);
    const items = markerGroups.get(date) ?? new Map();
    for (const item of marker.items) {
      const previous = items.get(item.id);
      if (!previous || item.appearances > previous.appearances) items.set(item.id, item);
    }
    markerGroups.set(date, items);
  }
  const series = visible.map((p) => {
    const counts = new Map(p.points.map((point) => [point.date, point.count]));
    return {
      provider: p.provider,
      points: dates.flatMap((date, index) =>
        counts.has(date) ? [{ date, index, count: counts.get(date)! }] : [],
      ),
    };
  });
  const max = Math.max(
      1,
      ...series.flatMap((p) => p.points.map((v) => v.count)),
    ),
    top = Math.ceil(max / 4) * 4;
  const x = (i: number) =>
      52 + (dates.length === 1 ? 0.5 : i / (dates.length - 1)) * 790,
    y = (n: number) => 275 - (n / top) * 235,
    bucketWidth = dates.length > 1 ? 790 / (dates.length - 1) : 40;
  const format = (date: string) =>
    summary.period.granularity === 'hourly'
      ? `${date.slice(11, 16)}`
      : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
  const fullDate = (date: string) =>
    summary.period.granularity === 'hourly'
      ? `${date.slice(0, 10)} ${date.slice(11, 16)} UTC`
      : `${format(date)}, ${date.slice(0, 4)} UTC`;
  const hoverDate = hover === undefined ? undefined : dates[hover];
  const card = (
    <section className="monitor-card mentions-trend">
      <header>
        <h2>Mentions Over Time</h2>
        <button
          aria-label={
            expanded ? 'Close expanded chart' : 'Expand mentions chart'
          }
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <X size={20} /> : <Maximize2 size={20} />}
        </button>
      </header>
      <div className="monitor-chart-legend">
        {summary.providers.map((p) => (
          <button
            key={p.provider}
            aria-pressed={!hidden.includes(p.provider)}
            onClick={() =>
              setHidden(
                hidden.includes(p.provider)
                  ? hidden.filter((v) => v !== p.provider)
                  : [...hidden, p.provider],
              )
            }
          >
            <i style={{ background: providerColors[p.provider] }} aria-hidden="true" />
            <ProviderMark provider={p.provider} />
            {PROVIDER_LABELS[p.provider]}
          </button>
        ))}
      </div>
      <div
        className="mentions-chart-body"
        role="region"
        aria-label="Mentions chart; scroll horizontally to see the full timeline"
        tabIndex={0}
      >
        <div className="mentions-chart-canvas">
          <svg
            viewBox="0 0 880 345"
            role="img"
            aria-label="Brand mentions by provider over time"
          >
            <desc>
              Points show measured mentions. Dashed lines connect scans across
              dates without a scan; those dates have no measured value.
              All dates and times are UTC.
            </desc>
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i}>
                <line
                  x1="52"
                  x2="842"
                  y1={y((i * top) / 4)}
                  y2={y((i * top) / 4)}
                  stroke="var(--line)"
                  strokeDasharray="3 3"
                />
                <text x="42" y={y((i * top) / 4) + 4} textAnchor="end">
                  {(i * top) / 4}
                </text>
              </g>
            ))}
            <text
              x="450"
              y="172"
              className="chart-watermark"
              textAnchor="middle"
            >
              citevia.
            </text>
            {series.map((p) => (
              <g key={p.provider} data-provider={p.provider} className="mentions-series">
                {p.points.slice(1).map((point, index) => {
                  const previous = p.points[index];
                  const gap = point.index - previous.index > 1;
                  return (
                    <line
                      key={point.date}
                      x1={x(previous.index)}
                      y1={y(previous.count)}
                      x2={x(point.index)}
                      y2={y(point.count)}
                      stroke={providerColors[p.provider]}
                      strokeWidth="2.5"
                      strokeDasharray={gap ? '6 5' : undefined}
                      opacity={gap ? '.75' : undefined}
                    />
                  );
                })}
              </g>
            ))}
            {(['openai', 'gemini', 'perplexity'] as const).flatMap((provider) =>
              (series.find((p) => p.provider === provider)?.points ?? [])
                .filter((point, index, points) =>
                  index === 0 || index === points.length - 1 ||
                  index % Math.max(1, Math.ceil(points.length / 14)) === 0 ||
                  point.index === hover,
                )
                .map((point) => (
                <g
                  key={`${provider}:${point.date}`}
                  className="mentions-measurement"
                  data-provider={provider}
                  transform={`translate(${x(point.index)},${y(point.count)})`}
                  fill="var(--surface)"
                  stroke={providerColors[provider]}
                  strokeWidth="1.5"
                  data-active={point.index === hover || undefined}
                >
                  <title>{`${PROVIDER_LABELS[provider]}: ${point.count} mentions on ${fullDate(point.date)}`}</title>
                  <MentionPoint provider={provider} />
                </g>
              )),
            )}
            {dates.map((date, i) => (
              <g key={date}>
                {(i % Math.max(1, Math.ceil(dates.length / 7)) === 0 ||
                  i === dates.length - 1) && (
                  <text x={x(i)} y="330" textAnchor="middle">
                    {format(date)}
                  </text>
                )}
                <rect
                  x={x(i) - bucketWidth / 2}
                  y="25"
                  width={bucketWidth}
                  height="260"
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${fullDate(date)}: ${visible.map((p) => `${PROVIDER_LABELS[p.provider]} ${p.points.find((v) => v.date === date)?.count ?? 'No scan'}`).join(', ')}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(undefined)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(undefined)}
                />
              </g>
            ))}
            {hover !== undefined && hoverDate !== undefined && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1="30"
                y2="275"
                stroke="var(--muted)"
                strokeDasharray="4"
                pointerEvents="none"
              />
            )}
          </svg>
          {!openMarker && hover !== undefined && hoverDate !== undefined && (
            <div
              className="monitor-tooltip chart-tooltip"
              style={{
                left: `clamp(16px, calc(${(x(hover) / 880) * 100}% - 110px), calc(100% - 236px))`,
              }}
            >
              <strong>{fullDate(hoverDate)}</strong>
              {visible.map((p) => (
                <span key={p.provider}>
                  {PROVIDER_LABELS[p.provider]}
                  <b>
                    {p.points.find((v) => v.date === hoverDate)?.count ??
                      'No scan'}
                  </b>
                </span>
              ))}
            </div>
          )}
          <div className="chart-markers">
            {[...markerGroups].map(([date, items]) => {
              const index = dates.indexOf(date);
              if (index < 0 || !items.size) return null;
              return (
                <TrackedPublicationMarker
                  key={date}
                  marker={{ date, items: [...items.values()] }}
                  left={(x(index) / 880) * 100}
                  label={fullDate(date)}
                  open={openMarker === date}
                  onToggle={() => setOpenMarker(openMarker === date ? undefined : date)}
                  onClose={() => setOpenMarker(undefined)}
                  onTracked={onTracked}
                />
              );
            })}
          </div>
        </div>
      </div>
      <p className="mentions-chart-note">
        Points show measured mentions. Dashed lines connect scans across gaps;
        dates without a scan have no measured value. All times UTC.
      </p>
    </section>
  );
  return (
    <>
      {expanded ? (
        <>
          <div className="chart-placeholder" />
          <ExpandedChart onClose={() => setExpanded(false)}>
            {card}
          </ExpandedChart>
        </>
      ) : (
        card
      )}
    </>
  );
}
export type AnswerPage = {
  items: MentionAnswer[];
  total: number;
  page: number;
  pageSize: number;
};
export function PageControls({
  total,
  page,
  pageSize,
  onPage,
  onSize,
  loading,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (n: number) => void;
  onSize: (n: number) => void;
  loading?: boolean;
}) {
  return (
    <nav className="monitor-pagination" aria-label="Table pagination">
      <div className="filter-pagination-label">
        <span>Rows per page:</span>
        <FilterDropdown
          label="Rows per page"
          value={String(pageSize)}
          disabled={loading}
          active={false}
          className="filter-dropdown-compact"
          onChange={(value) => onSize(Number(value))}
          options={[25, 50, 100].map((value) => ({
            value: String(value),
            label: String(value),
          }))}
        />
      </div>
      <span aria-live="polite" aria-atomic="true">
        {total ? Math.min(page * pageSize + 1, total) : 0}–
        {Math.min((page + 1) * pageSize, total)} of {total.toLocaleString()}
      </span>
      <button
        aria-label="Previous page"
        disabled={!page || loading}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={17} />
      </button>
      <button
        aria-label="Next page"
        disabled={(page + 1) * pageSize >= total || loading}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={17} />
      </button>
    </nav>
  );
}

function MentionBrands({ row }: { row: MentionAnswer }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});

  useEffect(() => {
    if (!open || !ref.current) return;
    const details = ref.current;
    const place = () => {
      const rect = details.getBoundingClientRect();
      const width = Math.min(260, window.innerWidth - 32);
      const below = window.innerHeight - rect.bottom;
      const openBelow = below >= 240 || below >= rect.top;
      setPosition({
        width,
        left: Math.max(
          16,
          Math.min(rect.right - width, window.innerWidth - width - 16),
        ),
        top: openBelow ? rect.bottom + 8 : undefined,
        bottom: openBelow ? undefined : window.innerHeight - rect.top + 8,
        maxHeight: Math.max(
          60,
          Math.min(240, (openBelow ? below : rect.top) - 24),
        ),
      });
    };
    const dismiss = (event: PointerEvent) => {
      if (!details.contains(event.target as Node)) details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        details.open = false;
        details.querySelector('summary')?.focus();
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!row.brands.length) return <span>—</span>;

  return (
    <details
      ref={ref}
      className="monitor-brands"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`${row.brands.length} brands`}>
        <span>
          {row.brands.slice(0, 3).map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="monitor-brand-logo"
              title={name}
            >
              <DomainLogo
                domain={
                  row.brandSites.find((brand) => brand.name === name)?.url
                }
                name={name}
                size={27}
              />
            </span>
          ))}
        </span>
        {row.brands.length > 3 && `+${row.brands.length - 3}`}
      </summary>
      <div
        className="monitor-tooltip"
        style={{
          ...position,
          visibility: position.width ? 'visible' : 'hidden',
        }}
        role="group"
        aria-label="Mentioned brands"
      >
        {row.brandSites.map((brand, i) =>
          brand.url ? (
            <a
              key={i}
              className="monitor-brand-link"
              href={brand.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <DomainLogo domain={brand.url} name={brand.name} size={22} />
              {brand.name}
            </a>
          ) : (
            <span key={i} className="monitor-brand-link">
              <DomainLogo name={brand.name} size={22} />
              {brand.name}
            </span>
          ),
        )}
      </div>
    </details>
  );
}

export function AnswerTable({
  rows,
  onResponse,
  sort = 'date',
  direction = 'desc',
  onSort,
}: {
  rows: MentionAnswer[];
  onResponse: (id: string) => void;
  sort?: string;
  direction?: string;
  onSort?: (sort: string) => void;
}) {
  return (
    <div
      className="monitor-table-scroll"
      role="region"
      aria-label="Brand mentions table; scroll horizontally for all columns"
      tabIndex={0}
    >
      <table className="monitor-answer-table">
        <caption className="visually-hidden">
          Saved AI answers mentioning your brand
        </caption>
        <thead>
          <tr>
            <th scope="col">Response</th>
            {(
              [
                'Model',
                'Rank',
                'Brands',
                'Citations',
                'Sentiment',
                'Date',
              ] as const
            ).map((label) => (
              <th
                key={label}
                scope="col"
                aria-sort={
                  onSort && sort === label.toLowerCase()
                    ? direction === 'desc'
                      ? 'descending'
                      : 'ascending'
                    : undefined
                }
              >
                {label === 'Brands' ? (
                  label
                ) : (
                  <button
                    disabled={!onSort}
                    onClick={() => onSort?.(label.toLowerCase())}
                  >
                    {label}
                    {sort === label.toLowerCase() &&
                      (direction === 'desc' ? (
                        <ArrowDown size={13} />
                      ) : (
                        <ArrowUp size={13} />
                      ))}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.responseId}
              onClick={(e) => {
                if (!(e.target as Element).closest('a,button,details'))
                  onResponse(row.responseId);
              }}
            >
              <td>
                <button
                  className="monitor-answer-button"
                  onClick={() => onResponse(row.responseId)}
                  aria-label={`Read answer to ${row.promptText}`}
                  title={row.promptText}
                >
                  {row.answerPreview ? (
                    <AnswerMarkdown text={row.answerPreview} preview />
                  ) : (
                    <span>Original answer unavailable</span>
                  )}
                </button>
              </td>
              <td>
                <span className="monitor-model" title={row.model}>
                  <ProviderMark provider={row.provider} />
                  {PROVIDER_LABELS[row.provider]}
                </span>
              </td>
              <td>{row.rank ?? '—'}</td>
              <td>
                <MentionBrands row={row} />
              </td>
              <td>
                <span className="monitor-citations">
                  <Link2 size={14} />
                  {row.citationCount}
                </span>
              </td>
              <td>
                <span
                  className={`mention-sentiment ${row.sentimentScore === null ? '' : row.sentimentScore >= 70 ? 'high' : row.sentimentScore >= 30 ? 'positive' : row.sentimentScore >= -30 ? 'neutral' : 'negative'}`}
                >
                  {row.sentimentScore ?? '—'}
                </span>
              </td>
              <td>
                <time
                  dateTime={row.date}
                  title={
                    new Date(row.date).toLocaleString('en-US', {
                      timeZone: 'UTC',
                    }) + ' UTC'
                  }
                >
                  {new Date(row.date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
