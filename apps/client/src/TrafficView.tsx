import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Layers3,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import {
  TRAFFIC_LABELS,
  TRAFFIC_PROVIDERS,
  trafficChange,
  trafficProvider,
  type Project,
  type TrafficDashboard,
  type TrafficProvider,
  type TrafficRow,
  type TrafficStatus,
} from '@citevia/core';
import { downloadCsv, query, request, useApi } from './api';
import { invalidateApiQueries } from './query-cache';
import { Empty, ErrorNotice } from './components';
import { Skeleton } from './Loading';
import DateRangeFilter, { type DateRangeSelection } from './DateRangeFilter';
import FilterDropdown from './FilterDropdown';
import './monitoring.css';
import './traffic.css';

const colors: Record<TrafficProvider, string> = {
  openai: '#252538',
  claude: '#de7950',
  perplexity: '#169bad',
  gemini: '#6688e8',
  copilot: '#e058a4',
  deepseek: '#8655ce',
};
const browserIcons: Record<string, string> = {
  Chrome: 'chrome',
  Safari: 'safari',
  Firefox: 'mozilla',
  Opera: 'opera',
};
const number = (n: number) => n.toLocaleString('en-US');
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryLabel(code: string) {
  return code === 'ZZ' ? 'Unknown location' : countryNames.of(code) || code;
}
function flag(code: string) {
  return code === 'ZZ'
    ? '◌'
    : String.fromCodePoint(...[...code].map((c) => 127397 + c.charCodeAt(0)));
}
function Mark({ provider }: { provider: TrafficProvider }) {
  return (
    <img
      className="traffic-provider-mark"
      src={`/providers/${provider}.svg`}
      width="22"
      height="22"
      alt=""
    />
  );
}
function Change({ current, previous }: { current: number; previous: number }) {
  const change = trafficChange(current, previous);
  return (
    <span
      className={`traffic-change ${change !== null && change < 0 ? 'negative' : change === 0 ? 'unchanged' : ''}`}
      title={`${number(previous)} visits in the previous period`}
    >
      {change === null ? (
        'New'
      ) : (
        <>
          {change < 0 ? (
            <ArrowDownRight size={12} />
          ) : change > 0 ? (
            <ArrowUpRight size={12} />
          ) : null}
          {change > 0 ? '+' : ''}
          {change}%
        </>
      )}
    </span>
  );
}
function Trend({ data }: { data: TrafficDashboard }) {
  const id = useId().replace(/:/g, '');
  const [hidden, setHidden] = useState<TrafficProvider[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(1100);
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const resize = () =>
      setChartWidth(Math.min(1100, Math.max(280, element.clientWidth)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const plotWidth = chartWidth - 84;
  const shown = data.providers.filter((p) => !hidden.includes(p.provider));
  const max = Math.max(
    4,
    ...data.series.map((p) =>
      Math.max(0, ...shown.map((s) => p.values[s.provider] || 0)),
    ),
  );
  const ceiling = Math.ceil(max / 4) * 4;
  const x = (i: number) =>
    60 + (i / Math.max(1, data.series.length - 1)) * plotWidth;
  const y = (v: number) => 290 - (v / ceiling) * 240;
  const path = (provider: TrafficProvider) =>
    data.series
      .map((point, i) => {
        const px = x(i),
          py = y(point.values[provider] || 0);
        if (!i) return `M ${px} ${py}`;
        const last = data.series[i - 1],
          mid = (px + x(i - 1)) / 2;
        return `C ${mid} ${y(last.values[provider] || 0)}, ${mid} ${py}, ${px} ${py}`;
      })
      .join(' ');
  const dateLabel = (value: string, full = false) =>
    new Date(value).toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      ...(data.period.granularity === 'hourly'
        ? { hour: 'numeric' as const }
        : {}),
      ...(full ? { year: 'numeric' as const } : {}),
    });
  const focused = hover === null ? null : data.series[hover];
  return (
    <section className="traffic-panel traffic-trend">
      <header>
        <div>
          <h2>LLM visit trends</h2>
          <p>Follow visits from each AI provider over time.</p>
        </div>
        <span className="traffic-caption">
          {data.period.granularity === 'hourly' ? 'Hourly' : 'Daily'} · UTC
        </span>
      </header>
      <div className="traffic-legend" aria-label="Chart providers">
        {data.providers.map((p) => (
          <button
            key={p.provider}
            aria-pressed={!hidden.includes(p.provider)}
            onClick={() =>
              setHidden((v) =>
                v.includes(p.provider)
                  ? v.filter((x) => x !== p.provider)
                  : [...v, p.provider],
              )
            }
          >
            <i style={{ background: colors[p.provider] }} />
            {TRAFFIC_LABELS[p.provider]}
          </button>
        ))}
      </div>
      <div
        ref={chart}
        className="traffic-chart"
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${chartWidth} 340`}
          role="img"
          aria-label="AI referral page visits by provider over time"
        >
          <defs>
            {shown.map((p) => (
              <linearGradient
                id={`${id}-${p.provider}`}
                key={p.provider}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={colors[p.provider]}
                  stopOpacity=".25"
                />
                <stop
                  offset="100%"
                  stopColor={colors[p.provider]}
                  stopOpacity=".015"
                />
              </linearGradient>
            ))}
          </defs>
          {[0, 1, 2, 3, 4].map((n) => (
            <g key={n}>
              <line
                x1="60"
                x2={chartWidth - 24}
                y1={y((n * ceiling) / 4)}
                y2={y((n * ceiling) / 4)}
                stroke="var(--line)"
                strokeDasharray="3 4"
              />
              <text x="46" y={y((n * ceiling) / 4) + 4} textAnchor="end">
                {number((n * ceiling) / 4)}
              </text>
            </g>
          ))}
          {shown.map((p) => (
            <g key={p.provider}>
              <path
                d={`${path(p.provider)} L ${x(data.series.length - 1)} 290 L 60 290 Z`}
                fill={`url(#${id}-${p.provider})`}
              />
              <path
                d={path(p.provider)}
                fill="none"
                stroke={colors[p.provider]}
                strokeWidth="2.5"
              />
              {data.series.length === 1 && (
                <circle
                  cx="60"
                  cy={y(data.series[0].values[p.provider] || 0)}
                  r="4"
                  fill={colors[p.provider]}
                />
              )}
            </g>
          ))}
          {data.series.map((p, i) =>
            i === 0 ||
            i === data.series.length - 1 ||
            i %
              Math.max(
                1,
                Math.ceil(
                  data.series.length /
                    Math.max(2, Math.floor(chartWidth / 110)),
                ),
              ) ===
              0 ? (
              <text
                key={p.date}
                x={x(i)}
                y="320"
                textAnchor={
                  i === 0
                    ? 'start'
                    : i === data.series.length - 1
                      ? 'end'
                      : 'middle'
                }
              >
                {dateLabel(p.date)}
              </text>
            ) : null,
          )}
          {focused && (
            <line
              x1={x(hover!)}
              x2={x(hover!)}
              y1="45"
              y2="290"
              stroke="var(--subtle)"
              strokeDasharray="4 4"
            />
          )}
          {data.series.map((point, i) => (
            <rect
              key={point.date}
              x={x(i) - plotWidth / 2 / Math.max(1, data.series.length - 1)}
              y="40"
              width={plotWidth / Math.max(1, data.series.length - 1)}
              height="255"
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {focused && (
          <div
            className="traffic-chart-tooltip"
            role="status"
            style={{
              left: `clamp(8px, ${(hover! / Math.max(1, data.series.length - 1)) * 100}%, calc(100% - 190px))`,
            }}
          >
            <strong>{dateLabel(focused.date, true)}</strong>
            {shown.map((p) => (
              <span key={p.provider}>
                <i style={{ background: colors[p.provider] }} />
                {TRAFFIC_LABELS[p.provider]}
                <b>{number(focused.values[p.provider] || 0)}</b>
              </span>
            ))}
          </div>
        )}
        {!data.current && (
          <div className="traffic-chart-empty">No AI visits in this period</div>
        )}
      </div>
      <div className="traffic-chart-access">
        <label>
          Inspect a date{' '}
          <select
            aria-label="Inspect chart date"
            value={hover ?? ''}
            onChange={(e) =>
              setHover(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            <option value="">Choose date</option>
            {data.series.map((p, i) => (
              <option key={p.date} value={i}>
                {dateLabel(p.date, true)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
function Breakdown({
  title,
  description,
  column,
  rows,
  render,
}: {
  title: string;
  description: string;
  column: string;
  rows: TrafficRow[];
  render?: (label: string) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 5) - 1),
  );
  const start = currentPage * 5;
  return (
    <section className="traffic-panel traffic-breakdown">
      <header>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th scope="col">{column}</th>
            <th scope="col">Visits</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(start, start + 5).map((row) => (
            <tr key={row.label}>
              <td title={row.label}>
                {render ? render(row.label) : row.label}
              </td>
              <td>{number(row.visits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="traffic-table-empty">No visits to show yet</div>
      )}
      {rows.length > 5 && (
        <footer>
          <span>
            {start + 1}–{Math.min(start + 5, rows.length)} of {rows.length}
          </span>
          <button
            className="icon-button"
            aria-label={`Previous ${title.toLowerCase()} page`}
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={`Next ${title.toLowerCase()} page`}
            disabled={start + 5 >= rows.length}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </footer>
      )}
    </section>
  );
}
function TrafficSettings({
  path,
  project,
  notify,
  onDashboard,
}: {
  path: string;
  project: Project;
  notify: (message: string) => void;
  onDashboard: () => void;
}) {
  const status = useApi<TrafficStatus>(`${path}/traffic/status`);
  const [testing, setTesting] = useState(false),
    [result, setResult] = useState(''),
    [error, setError] = useState<Error>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const base = new URL(
    String(import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '') + '/',
    window.location.origin,
  );
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const snippet = `<script async src="${escape(new URL('traffic/tracker.js', base).href)}" data-project-id="${escape(project.id)}"></script>`;
  const domain = project.brand.domains[0];
  const [testUrl, setTestUrl] = useState(domain || '');
  const [urlEdited, setUrlEdited] = useState(false);
  const detectedOrigin = status.data?.sites?.[0]?.origin;
  useEffect(() => {
    if (detectedOrigin && !urlEdited) setTestUrl(detectedOrigin);
  }, [detectedOrigin, urlEdited]);
  const installed = Boolean(status.data?.installed || status.data?.hasEvents);
  let target: URL | null = null;
  try {
    if (testUrl.trim()) {
      const value = testUrl.trim();
      const parsed = new URL(
        value.includes('://') ? value : `https://${value}`,
      );
      if (
        ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      )
        target = parsed;
    }
  } catch {
    /* No configured website. */
  }
  const test = async () => {
    if (!target || testing) return;
    const id = crypto.randomUUID();
    target.searchParams.set('utm_source', 'chatgpt');
    target.searchParams.set('citevia_test', id);
    const popup = window.open(target.href, '_blank');
    if (!popup) {
      setError(
        new Error(
          'Allow pop-ups to open your website for the connection test.',
        ),
      );
      return;
    }
    popup.opener = null;
    setTesting(true);
    setResult('Waiting for your test visit…');
    setError(undefined);
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new DOMException('Cancelled', 'AbortError'));
          };
          const timer = setTimeout(() => {
            abort.signal.removeEventListener('abort', cancel);
            resolve();
          }, 2000);
          abort.signal.addEventListener('abort', cancel, { once: true });
        });
        const check = await request<TrafficStatus>(
          `${path}/traffic/status${query({ testId: id })}`,
          { signal: abort.signal },
        );
        if (check.testReceived) {
          setResult('Connection verified. Citevia received your test visit.');
          void invalidateApiQueries(`${path}/traffic`);
          return;
        }
      }
      setResult(
        'No test visit received. Check that the script is published, then try again. If your site requests consent, accept it in the test tab.',
      );
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e as Error);
        setResult('');
      }
    } finally {
      if (!abort.signal.aborted) setTesting(false);
    }
  };
  return (
    <div className="traffic-settings">
      <section className="traffic-panel">
        <header>
          <div>
            <span className="traffic-eyebrow">WEBSITE CONNECTION</span>
            <h2>See where AI sends your audience</h2>
            <p>
              Add the Citevia tracker to your website to start measuring AI
              referral visits.
            </p>
          </div>
          <span
            className={`traffic-connection ${installed ? 'connected' : ''}`}
          >
            <i />
            {installed ? 'Tracker detected' : 'Awaiting first event'}
          </span>
        </header>
        <div className="traffic-install">
          <div className="traffic-step">
            <b>1</b>
            <div>
              <h3>Install your tracking script</h3>
              <p>
                Paste this snippet inside the <code>&lt;head&gt;</code> of your
                website, or add it as a custom HTML tag in your tag manager.
                Publish it on every page you want to measure. This script
                records visits under {project.name || project.brand.name} on any
                website where you install it.
              </p>
            </div>
          </div>
          <div className="traffic-code">
            <pre>
              <code>{snippet}</code>
            </pre>
            <button
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(snippet);
                  notify('Tracking script copied.');
                } catch {
                  setError(
                    new Error(
                      'Could not copy. Select the script and copy it manually.',
                    ),
                  );
                }
              }}
            >
              <Copy size={15} />
              Copy script
            </button>
          </div>
          <div className="traffic-step">
            <b>2</b>
            <div>
              <h3>Verify your connection</h3>
              <p>
                Open the website where you installed this script. We’ll check
                that a fresh signal from that page reaches Citevia. Test visits
                stay out of your reports.
              </p>
            </div>
          </div>
          <label className="traffic-test-url">
            Website URL
            <input
              type="url"
              value={testUrl}
              placeholder="https://example.com"
              onChange={(event) => {
                setUrlEdited(true);
                setTestUrl(event.target.value);
              }}
            />
          </label>
          <div className="traffic-test-actions">
            <button
              className="button button-primary"
              disabled={testing || !target}
              onClick={() => void test()}
            >
              {testing ? (
                <RefreshCw size={15} className="spinner" />
              ) : (
                <ExternalLink size={15} />
              )}{' '}
              {testing ? 'Checking connection…' : 'Test connection'}
            </button>
            <button className="button button-secondary" onClick={onDashboard}>
              View AI traffic
            </button>
          </div>
          {!target && (
            <p className="traffic-help">
              Enter the website URL where you installed the script.
            </p>
          )}
          {result && (
            <p className="traffic-test-result" role="status">
              {result.startsWith('Connection verified') && <Check size={17} />}{' '}
              {result}
            </p>
          )}
          <ErrorNotice error={error || status.error} />
          {status.data?.sites?.length ? (
            <div className="traffic-detected-sites">
              <h3>Detected websites</h3>
              {status.data.sites.map((site) => (
                <div key={site.origin}>
                  <a href={site.origin} target="_blank" rel="noreferrer">
                    {site.origin}
                  </a>
                  <span>
                    Last seen {new Date(site.lastSeenAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {status.data?.lastReceivedAt && (
            <p className="traffic-help">
              Last event received{' '}
              {new Date(status.data.lastReceivedAt).toLocaleString()}.
            </p>
          )}
        </div>
      </section>
      <section className="traffic-panel traffic-measurement">
        <Activity size={22} />
        <div>
          <h3>What the tracker measures</h3>
          <p>
            Page visits referred by ChatGPT, Claude, Perplexity, Gemini, Copilot
            and DeepSeek, including supported <code>utm_source</code> tags. It
            uses no cookies, strips query strings, and does not store visitor IP
            addresses. Locations are approximate. Visits without an AI referrer
            or supported tag cannot be attributed.
          </p>
          <p>
            Counts represent page visits. Crawlers, unique visitors and
            conversions are separate measurements.
          </p>
          <small>
            Country lookup uses GeoLite2 data created by{' '}
            <a href="https://www.maxmind.com" target="_blank" rel="noreferrer">
              MaxMind
            </a>
            .
          </small>
        </div>
      </section>
    </div>
  );
}
export default function TrafficView({
  path,
  project,
  notify,
}: {
  path: string;
  project: Project;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<'traffic' | 'settings'>('traffic');
  const [range, setRange] = useState<DateRangeSelection>({
    days: '7',
    start: '',
    end: '',
  });
  const [providers, setProviders] = useState<TrafficProvider[]>([]),
    [countries, setCountries] = useState<string[]>([]);
  const filters = query({
    ...range,
    start: range.days === 'custom' ? range.start : undefined,
    end: range.days === 'custom' ? range.end : undefined,
    providers: providers.join(','),
    countries: countries.join(','),
  });
  const report = useApi<TrafficDashboard>(`${path}/traffic${filters}`);
  const data = report.data;
  const exportReport = () => {
    if (!data) return;
    const rows: (string | number)[][] = data.providers.map((p) => [
      'Provider',
      TRAFFIC_LABELS[p.provider],
      p.visits,
      p.previous,
    ]);
    for (const [label, items] of [
      ['Source', data.sources],
      ['Page', data.pages],
      ['Location', data.locations],
      ['Device', data.devices],
      ['Browser', data.browsers],
    ] as const)
      rows.push(...items.map((r) => [label, r.label, r.visits, '']));
    for (const point of data.series)
      for (const provider of data.providers)
        rows.push([
          'Trend',
          `${point.date} ${TRAFFIC_LABELS[provider.provider]}`,
          point.values[provider.provider] || 0,
          '',
        ]);
    downloadCsv(
      `citevia-ai-traffic-${data.period.start.slice(0, 10)}.csv`,
      ['Breakdown', 'Name', 'Visits', 'Previous period visits'],
      rows,
    );
  };
  const countryOptions = [
    ...new Set([...(data?.countries || []), ...countries]),
  ].sort();
  return (
    <div className="monitor-screen traffic-screen">
      <div className="monitor-filter-header">
        <h1>AI Traffic</h1>
        {tab === 'traffic' && (
          <div className="monitor-filters">
            <FilterDropdown
              label="Providers"
              placeholder="Providers"
              icon={<Layers3 size={17} />}
              multiple
              value={providers}
              onChange={(v) => setProviders(v as TrafficProvider[])}
              options={[
                { value: '', label: 'All providers' },
                ...TRAFFIC_PROVIDERS.map((p) => ({
                  value: p,
                  label: TRAFFIC_LABELS[p],
                  icon: <Mark provider={p} />,
                })),
              ]}
            />
            <FilterDropdown
              label="Regions"
              placeholder="Regions"
              icon={<Globe2 size={17} />}
              multiple
              value={countries}
              onChange={setCountries}
              options={[
                { value: '', label: 'All regions' },
                ...countryOptions.map((c) => ({
                  value: c,
                  label: countryLabel(c),
                  icon: <span>{flag(c)}</span>,
                })),
              ]}
            />
            <DateRangeFilter value={range} onChange={setRange} />
            <button
              className="icon-button traffic-export"
              aria-label="Export traffic CSV"
              title="Export traffic CSV"
              disabled={!data || report.loading}
              onClick={exportReport}
            >
              <Download size={17} />
            </button>
          </div>
        )}
      </div>
      <div className="traffic-tabs" aria-label="AI Traffic views">
        <button
          aria-pressed={tab === 'traffic'}
          onClick={() => setTab('traffic')}
        >
          AI Traffic
        </button>
        <button
          aria-pressed={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </div>
      {tab === 'settings' ? (
        <TrafficSettings
          path={path}
          project={project}
          notify={notify}
          onDashboard={() => setTab('traffic')}
        />
      ) : (
        <>
          <ErrorNotice error={report.error} />
          {report.loading && !data ? (
            <Skeleton variant="dashboard" label="Loading AI traffic…" />
          ) : (
            data && (
              <>
                {!data.status.installed && !data.status.hasEvents && (
                  <div className="traffic-setup-banner">
                    <span className="traffic-banner-icon">
                      <Activity size={22} />
                    </span>
                    <div>
                      <h2>Connect your website to see AI traffic</h2>
                      <p>
                        Install your tracking script to see the visits AI brings
                        to {project.brand.name}.
                      </p>
                    </div>
                    <button
                      className="button button-primary"
                      onClick={() => setTab('settings')}
                    >
                      Set up tracking <ChevronRight size={15} />
                    </button>
                  </div>
                )}
                {data.status.installed && !data.status.hasEvents && (
                  <div className="traffic-installation-notice">
                    <Check size={18} />
                    <span>
                      Tracker detected
                      {data.status.sites?.[0]?.origin
                        ? ` on ${new URL(data.status.sites[0].origin).hostname}`
                        : ''}
                      . AI referral visits will appear here as they arrive.
                    </span>
                    <button onClick={() => setTab('settings')}>
                      Connection details
                    </button>
                  </div>
                )}
                <div
                  className="traffic-metrics"
                  aria-label="AI referral visits"
                  aria-busy={report.loading}
                >
                  <article className="traffic-metric traffic-total">
                    <div>
                      <Activity size={20} />
                      <h2>Total entries</h2>
                    </div>
                    <section>
                      <strong>{number(data.current)}</strong>
                      <Change current={data.current} previous={data.previous} />
                    </section>
                    <p>Visits in the selected period</p>
                  </article>
                  {data.providers.map((p) => (
                    <article key={p.provider} className="traffic-metric">
                      <div>
                        <Mark provider={p.provider} />
                        <h2>{TRAFFIC_LABELS[p.provider]}</h2>
                      </div>
                      <section>
                        <strong>{number(p.visits)}</strong>
                        <Change current={p.visits} previous={p.previous} />
                      </section>
                      <p>Visits in the selected period</p>
                    </article>
                  ))}
                </div>
                <div className="traffic-period-note">
                  <span>
                    Compared with{' '}
                    {new Date(data.previousPeriod.start).toLocaleDateString(
                      'en-US',
                      { month: 'short', day: 'numeric', timeZone: 'UTC' },
                    )}{' '}
                    –{' '}
                    {new Date(data.previousPeriod.end).toLocaleDateString(
                      'en-US',
                      { month: 'short', day: 'numeric', timeZone: 'UTC' },
                    )}{' '}
                    · Page visits
                  </span>
                  {(providers.length > 0 ||
                    countries.length > 0 ||
                    range.days !== '7') && (
                    <button
                      onClick={() => {
                        setProviders([]);
                        setCountries([]);
                        setRange({ days: '7', start: '', end: '' });
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
                <Trend data={data} />
                <div className="traffic-breakdowns" key={filters}>
                  <Breakdown
                    title="Top Sources"
                    description="The referral sources sending AI traffic to your website."
                    column="Source"
                    rows={data.sources}
                    render={(label) => {
                      const p = trafficProvider(`https://${label}`);
                      return (
                        <span className="traffic-row-label">
                          {p && <Mark provider={p} />}
                          <span>{label}</span>
                        </span>
                      );
                    }}
                  />
                  <Breakdown
                    title="Top Pages"
                    description="Your most visited pages from AI referrals."
                    column="Page"
                    rows={data.pages}
                  />
                  <Breakdown
                    title="Top Locations"
                    description="Where visitors arriving through AI are located."
                    column="Country"
                    rows={data.locations}
                    render={(label) => (
                      <span className="traffic-row-label">
                        <span aria-hidden="true">{flag(label)}</span>
                        <span>{countryLabel(label)}</span>
                      </span>
                    )}
                  />
                  <Breakdown
                    title="Top Devices"
                    description="Devices used to visit your website through AI."
                    column="Device"
                    rows={data.devices}
                    render={(label) => (
                      <span className="traffic-row-label">
                        {label === 'mobile' ? (
                          <Smartphone size={18} />
                        ) : label === 'tablet' ? (
                          <Tablet size={18} />
                        ) : (
                          <Monitor size={18} />
                        )}
                        <span className="traffic-capitalize">{label}</span>
                      </span>
                    )}
                  />
                  <Breakdown
                    title="Top Browsers"
                    description="Browsers used by visitors arriving through AI."
                    column="Browser"
                    rows={data.browsers}
                    render={(label) => (
                      <span className="traffic-row-label">
                        {browserIcons[label] ? (
                          <img
                            src={`/browsers/${browserIcons[label]}.svg`}
                            width="20"
                            height="20"
                            alt=""
                          />
                        ) : (
                          <Globe2 size={18} />
                        )}
                        <span>{label}</span>
                      </span>
                    )}
                  />
                </div>
              </>
            )
          )}
          {!data && !report.loading && !report.error && (
            <Empty
              title="No traffic report available"
              description="Refresh to try again."
            />
          )}
        </>
      )}
    </div>
  );
}
