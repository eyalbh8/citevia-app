import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Box,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Hexagon,
  Link2,
  Maximize2,
  Tag,
  TerminalSquare,
  X,
} from 'lucide-react';
import {
  PROVIDER_LABELS,
  projectProviders,
  type Project,
  type ScanProvider,
  type MentionAnswer,
  type MonitoringPeriod,
  type MentionsSummary,
} from '@citevia/core';
import { query } from './api';
import AnswerMarkdown from './AnswerMarkdown';
import './monitoring.css';
export const providerColors: Record<ScanProvider, string> = {
  openai: '#242320',
  perplexity: '#ed8436',
  gemini: '#74a3ee',
};
export type MonitorSelection = {
  days: string;
  start: string;
  end: string;
  providers: string[];
  region: string;
  tag: string;
  branded: string;
  intent: string;
};
export const initialSelection = (days = '7'): MonitorSelection => ({
  days,
  start: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
  end: new Date().toISOString().slice(0, 10),
  providers: [],
  region: '',
  tag: '',
  branded: '',
  intent: '',
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
function Pill({
  label,
  icon,
  value,
  onChange,
  children,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="monitor-pill">
      {icon}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}
export function MonitoringHeader({
  title,
  project,
  value,
  onChange,
  children,
}: {
  title: string;
  project: Project;
  value: MonitorSelection;
  onChange: (s: MonitorSelection) => void;
  children?: ReactNode;
}) {
  const set = (key: keyof MonitorSelection, next: string) =>
    onChange({ ...value, [key]: next });
  const tags = [
      ...new Set(project.prompts.flatMap((p) => p.tags || [])),
    ].sort(),
    intents = [
      ...new Set(project.prompts.flatMap((p) => (p.intent ? [p.intent] : []))),
    ].sort();
  return (
    <div className="monitor-filter-header">
      <h1>{title}</h1>
      <div className="monitor-filters">
        <Pill
          label="Regions"
          icon={<Globe2 size={17} />}
          value={value.region}
          onChange={(v) => set('region', v)}
        >
          <option value="">Regions</option>
          <option value={project.country}>{project.country}</option>
        </Pill>
        <Pill
          label="Tags"
          icon={<Tag size={17} />}
          value={value.tag}
          onChange={(v) => set('tag', v)}
        >
          <option value="">Tags</option>
          {tags.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </Pill>
        <Pill
          label="Branded"
          icon={<Hexagon size={17} />}
          value={value.branded}
          onChange={(v) => set('branded', v)}
        >
          <option value="">Branded</option>
          <option value="true">Branded</option>
          <option value="false">Non-branded</option>
        </Pill>
        <Pill
          label="Prompt Types"
          icon={<TerminalSquare size={17} />}
          value={value.intent}
          onChange={(v) => set('intent', v)}
        >
          <option value="">Prompt Types</option>
          {intents.map((v) => (
            <option key={v} value={v}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </option>
          ))}
        </Pill>
        <details className="monitor-provider-select">
          <summary className="monitor-pill">
            <Box size={17} />
            {value.providers.length
              ? `${value.providers.length} Providers`
              : 'Providers'}
            <ChevronDown size={14} />
          </summary>
          <div className="monitor-provider-menu">
            <button onClick={() => onChange({ ...value, providers: [] })}>
              All providers
            </button>
            {projectProviders(project).map(({ provider }) => (
              <label key={provider}>
                <input
                  type="checkbox"
                  checked={value.providers.includes(provider)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      providers: e.target.checked
                        ? [...value.providers, provider]
                        : value.providers.filter((p) => p !== provider),
                    })
                  }
                />
                {PROVIDER_LABELS[provider]}
              </label>
            ))}
          </div>
        </details>
        <Pill
          label="Date range"
          icon={<CalendarDays size={17} />}
          value={value.days}
          onChange={(v) => set('days', v)}
        >
          <option value="1">Last 24 hours</option>
          {[7, 30, 90].map((days) => (
            <option key={days} value={days}>
              Last {days} days
            </option>
          ))}
          <option value="custom">Custom range</option>
        </Pill>
        {value.days === 'custom' && (
          <div className="monitor-custom-dates">
            <input
              aria-label="Start date"
              type="date"
              value={value.start}
              max={value.end}
              onChange={(e) => set('start', e.target.value)}
            />
            <span>–</span>
            <input
              aria-label="End date"
              type="date"
              value={value.end}
              min={value.start}
              onChange={(e) => set('end', e.target.value)}
            />
          </div>
        )}
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
            stroke="#f0edf4"
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
                    {PROVIDER_LABELS[p.provider]}: {p.count} mentions ({p.share}
                    %)
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
function curve(points: number[][]) {
  return points
    .map(([x, y], i) =>
      i === 0
        ? `M${x},${y}`
        : `C${(points[i - 1][0] + x) / 2},${points[i - 1][1]} ${(points[i - 1][0] + x) / 2},${y} ${x},${y}`,
    )
    .join(' ');
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
    [hidden, setHidden] = useState<ScanProvider[]>([]);
  const dates = buckets(summary.period),
    visible = summary.providers.filter((p) => !hidden.includes(p.provider));
  const max = Math.max(
      1,
      ...visible.flatMap((p) => p.points.map((v) => v.count)),
    ),
    top = Math.ceil(max / 4) * 4;
  const x = (i: number) =>
      52 + (dates.length === 1 ? 0.5 : i / (dates.length - 1)) * 790,
    y = (n: number) => 275 - (n / top) * 235;
  const format = (date: string) =>
    summary.period.granularity === 'hourly'
      ? `${date.slice(11, 16)}`
      : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
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
            style={{ opacity: hidden.includes(p.provider) ? 0.4 : 1 }}
            onClick={() =>
              setHidden(
                hidden.includes(p.provider)
                  ? hidden.filter((v) => v !== p.provider)
                  : [...hidden, p.provider],
              )
            }
          >
            <i style={{ background: providerColors[p.provider] }} />
            {PROVIDER_LABELS[p.provider]}
          </button>
        ))}
      </div>
      <div className="mentions-chart-body">
        <svg
          viewBox="0 0 880 345"
          role="img"
          aria-label="Brand mentions by provider over time"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line
                x1="52"
                x2="842"
                y1={y((i * top) / 4)}
                y2={y((i * top) / 4)}
                stroke="#e9e5e9"
                strokeDasharray="3 3"
              />
              <text x="42" y={y((i * top) / 4) + 4} textAnchor="end">
                {(i * top) / 4}
              </text>
            </g>
          ))}
          <text x="450" y="172" className="chart-watermark" textAnchor="middle">
            citevia.
          </text>
          {visible.map((p) => {
            const map = new Map(p.points.map((v) => [v.date, v.count])),
              segments: number[][][] = [];
            let segment: number[][] = [];
            for (let i = 0; i < dates.length; i++) {
              if (map.has(dates[i]))
                segment.push([x(i), y(map.get(dates[i])!)]);
              else if (segment.length) {
                segments.push(segment);
                segment = [];
              }
            }
            if (segment.length) segments.push(segment);
            return (
              <g key={p.provider}>
                {segments.map((points, i) => {
                  const path = curve(points);
                  return (
                    <g key={i}>
                      <path
                        d={`${path} L${points.at(-1)![0]},275 L${points[0][0]},275 Z`}
                        fill={providerColors[p.provider]}
                        opacity=".14"
                      />
                      <path
                        d={path}
                        fill="none"
                        stroke={providerColors[p.provider]}
                        strokeWidth="2.5"
                      />
                      {points.length === 1 && (
                        <circle
                          cx={points[0][0]}
                          cy={points[0][1]}
                          r="3"
                          fill={providerColors[p.provider]}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {dates.map((date, i) => (
            <g key={date}>
              {(i % Math.max(1, Math.ceil(dates.length / 7)) === 0 ||
                i === dates.length - 1) && (
                <text x={x(i)} y="330" textAnchor="middle">
                  {format(date)}
                </text>
              )}
              <rect
                x={x(i) - Math.max(5, 790 / dates.length / 2)}
                y="25"
                width={Math.max(10, 790 / dates.length)}
                height="260"
                fill="transparent"
                tabIndex={0}
                aria-label={`${format(date)}: ${visible.map((p) => `${PROVIDER_LABELS[p.provider]} ${p.points.find((v) => v.date === date)?.count ?? 'No scan'}`).join(', ')}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(undefined)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(undefined)}
              />
            </g>
          ))}
          {hover !== undefined && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1="30"
              y2="275"
              stroke="#998ea4"
              strokeDasharray="4"
              pointerEvents="none"
            />
          )}
        </svg>
        {hover !== undefined && (
          <div className="monitor-tooltip chart-tooltip">
            <strong>{format(dates[hover])} · UTC</strong>
            {visible.map((p) => (
              <span key={p.provider}>
                {PROVIDER_LABELS[p.provider]}
                <b>
                  {p.points.find((v) => v.date === dates[hover])?.count ??
                    'No scan'}
                </b>
              </span>
            ))}
          </div>
        )}
        <div className="chart-markers">
          {summary.markers.map((marker) => {
            const index = dates.indexOf(marker.date);
            if (index < 0) return null;
            return (
              <details
                key={marker.date}
                style={{ left: `${(x(index) / 880) * 100}%` }}
              >
                <summary
                  aria-label={`${marker.items.length} tracked URLs on ${format(marker.date)}`}
                >
                  <Link2 size={11} />
                  {marker.items.length}
                </summary>
                <div className="monitor-tooltip marker-tooltip">
                  {marker.items.map((item) => (
                    <button key={item.id} onClick={() => onTracked(item.id)}>
                      <strong>{item.title}</strong>
                      <small>{item.url}</small>
                      <span>{item.appearances} appearances</span>
                    </button>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </div>
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
    <div className="monitor-pagination">
      <label>
        Rows per page:{' '}
        <select
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => onSize(Number(e.target.value))}
        >
          {[25, 50, 100].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <span>
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
    </div>
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
    <div className="monitor-table-scroll">
      <table className="monitor-answer-table">
        <thead>
          <tr>
            <th>Response</th>
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
              <th key={label}>
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
                <details className="monitor-brands">
                  <summary aria-label={`${row.brands.length} brands`}>
                    <span>
                      {row.brands.slice(0, 3).map((name, i) => (
                        <i key={`${name}-${i}`} title={name}>
                          {name.slice(0, 2)}
                        </i>
                      ))}
                    </span>
                    {row.brands.length > 3 && `+${row.brands.length - 3}`}
                    {!row.brands.length && '—'}
                  </summary>
                  <div className="monitor-tooltip">
                    {row.brandSites.map((brand, i) =>
                      brand.url ? (
                        <a
                          key={i}
                          href={brand.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {brand.name}
                        </a>
                      ) : (
                        <span key={i}>{brand.name}</span>
                      ),
                    )}
                  </div>
                </details>
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
