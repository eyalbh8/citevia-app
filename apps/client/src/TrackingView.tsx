import { useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Link2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  PROVIDER_LABELS,
  type Project,
  type TrackingDetail,
  type TrackingRow,
  type TrackingSummary,
  type TrackingStatus,
} from '@citevia/core';
import { request, useApi } from './api';
import { Drawer, Empty, ErrorNotice, Spinner } from './components';
import {
  AnswerTable,
  initialSelection,
  MonitoringHeader,
  PageControls,
  ProviderMark,
  providerColors,
  selectionQuery,
  type AnswerPage,
  type MonitorSelection,
} from './MonitoringUI';

const statusLabels: Record<TrackingStatus, string> = {
  published: 'Published',
  crawled: 'Crawled',
  cited: 'Cited',
  stale: 'No pickup',
  lost: 'Lost',
};
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '—';
const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const safeHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg
      className="tracking-sparkline"
      viewBox="0 0 100 26"
      aria-label="Citation trend"
      role="img"
    >
      <polyline
        fill="none"
        stroke="#5baf90"
        strokeWidth="2"
        points={
          values.length
            ? values
                .map(
                  (n, i) =>
                    `${values.length === 1 ? 50 : (i / (values.length - 1)) * 100},${24 - (n / max) * 20}`,
                )
                .join(' ')
            : '0,24 100,24'
        }
      />
    </svg>
  );
}
function TrackingTrend({ summary }: { summary: TrackingSummary }) {
  const [metric, setMetric] = useState<'citations' | 'mentions' | 'clicks'>(
    'citations',
  );
  const max = Math.max(
    1,
    ...summary.series.map((p) => (metric === 'clicks' ? 0 : p[metric])),
  );
  return (
    <section className="monitor-card tracking-trend">
      <header>
        <div>
          <h2>
            {metric === 'citations'
              ? 'AI citations across your tracked URLs'
              : metric === 'mentions'
                ? 'Brand mentions in AI answers over time'
                : 'Clicks from AI answers over time'}
          </h2>
          <p>Monthly totals · Last 7 months</p>
        </div>
        <div className="tracking-tabs" role="group" aria-label="Trend metric">
          {(['citations', 'mentions', 'clicks'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {value === 'clicks'
                ? 'AI clicks'
                : value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </header>
      {metric === 'clicks' ? (
        <Empty
          title="Click data unavailable"
          description="AI referrals require a connected website analytics source. Scan citations do not measure clicks."
        />
      ) : (
        <div className="tracking-month-chart">
          {summary.series.map((point) => (
            <div key={point.date} className="tracking-month">
              <div
                className="tracking-month-bar"
                title={`${point[metric]} ${metric}; ${point.published} URLs published`}
              >
                <span>{point[metric].toLocaleString()}</span>
                <i
                  style={{
                    height: `${Math.max(1, (point[metric] / max) * 140)}px`,
                  }}
                />
              </div>
              <small>
                {new Date(`${point.date}-01T12:00:00Z`).toLocaleDateString(
                  'en',
                  { month: 'short', timeZone: 'UTC' },
                )}
              </small>
              <small>{point.published} published</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export default function TrackingView({
  path,
  project,
  revision,
  onResponse,
  notify,
}: {
  path: string;
  project: Project;
  revision: number;
  onResponse: (id: string) => void;
  notify: (s: string) => void;
}) {
  const [selection, setSelection] = useState(() => initialSelection('30')),
    [status, setStatus] = useState('all'),
    [sort, setSort] = useState('newest'),
    [group, setGroup] = useState('status'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [size, setSize] = useState(25),
    [selected, setSelected] = useState<string>(),
    [adding, setAdding] = useState(false),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>(),
    [localRevision, refresh] = useState(0);
  const currentRevision = revision + localRevision;
  const list = useApi<{ items: TrackingRow[]; total: number }>(
    `${path}/tracked-urls${selectionQuery(selection, { status, sort, q: search, page, pageSize: size })}`,
    currentRevision,
  );
  const summary = useApi<TrackingSummary>(
    `${path}/tracked-urls/summary${selectionQuery(selection)}`,
    currentRevision,
  );
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const saved = await request<TrackingRow>(`${path}/tracked-urls`, {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      });
      setAdding(false);
      setUrl('');
      refresh((r) => r + 1);
      setStatus(saved.active ? 'all' : 'paused');
      setPage(0);
      setSelection(initialSelection('30'));
      notify(
        saved.active
          ? 'Tracking activated. Future scans will check this URL.'
          : 'This URL is paused. Resume it from its details.',
      );
      setSelected(saved.id);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const rows = list.data?.items || [],
    groups = new Map<string, TrackingRow[]>();
  for (const row of rows) {
    const key =
      group === 'none'
        ? ''
        : group === 'month'
          ? row.publishedAt.slice(0, 7)
          : row.status === 'cited'
            ? 'Cited'
            : ['lost', 'stale'].includes(row.status)
              ? 'At risk'
              : 'Not cited';
    const items = groups.get(key) || [];
    items.push(row);
    groups.set(key, items);
  }
  return (
    <div className="monitor-screen tracking-screen">
      <MonitoringHeader
        title="Tracking"
        project={project}
        value={selection}
        onChange={(s) => {
          setSelection(s);
          setPage(0);
        }}
      />
      <div className="tracking-intro">
        <div>
          <span className="tracking-eyebrow">CONTENT PERFORMANCE</span>
          <h2>Track your content in AI answers</h2>
          <p>Follow every URL from publication to its first citation.</p>
        </div>
        {project.role === 'owner' && (
          <button className="tracking-add" onClick={() => setAdding(true)}>
            <Plus size={17} />
            Track results
          </button>
        )}
      </div>
      <ErrorNotice error={list.error || summary.error} />
      {summary.loading && !summary.data ? (
        <Spinner label="Loading tracked URLs…" />
      ) : (
        summary.data && (
          <>
            <div className="tracking-kpis">
              <div>
                <small>
                  <Link2 size={14} />
                  Tracked URLs
                </small>
                <strong>{summary.data.trackedCount}</strong>
                <span>+{summary.data.trackedThisMonth} this month</span>
              </div>
              <div title="Lifetime source occurrences for URLs published in this range">
                <small>Citations in AI answers</small>
                <strong>{summary.data.appearances.toLocaleString()}</strong>
                <span>Lifetime appearances</span>
              </div>
              <div>
                <small>Cited at least once</small>
                <strong>{summary.data.citedRate}%</strong>
                <span>
                  {summary.data.citedCount} of {summary.data.trackedCount} URLs
                </span>
              </div>
              <div>
                <small>
                  <Clock3 size={14} />
                  Median time to pickup
                </small>
                <strong>
                  {summary.data.medianPickup === null
                    ? '—'
                    : daysLabel(summary.data.medianPickup)}
                </strong>
                <span>Publication to first citation</span>
              </div>
            </div>
            <TrackingTrend summary={summary.data} />
          </>
        )
      )}
      <div className="tracking-controls">
        <div
          className="tracking-tabs"
          role="group"
          aria-label="Tracking status"
        >
          {[
            ['all', 'All'],
            ['cited', 'Cited'],
            ['uncited', 'Not cited'],
            ['attention', 'At risk'],
            ['paused', 'Paused'],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={status === key}
              onClick={() => {
                setStatus(key);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="tracking-count">
          {list.data?.total || 0} tracked URLs
        </span>
        <label className="tracking-search">
          <Search size={15} />
          <input
            aria-label="Search tracked URLs"
            placeholder="Search content or URL…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="monitor-pill">
          <select
            aria-label="Sort tracked URLs"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(0);
            }}
          >
            <option value="newest">Newest</option>
            <option value="cited">Most cited</option>
            <option value="fastest">Fastest pickup</option>
            <option value="az">A–Z</option>
            <option value="lift" disabled>
              Lift · unavailable
            </option>
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="monitor-pill">
          <select
            aria-label="Group tracked URLs"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="status">Group: Status</option>
            <option value="month">Group: Month</option>
            <option value="none">No grouping</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      <section
        className="monitor-card tracking-table-panel"
        aria-busy={list.loading}
      >
        {list.loading && !list.data ? (
          <Spinner label="Loading URL results…" />
        ) : rows.length ? (
          <>
            <div className="monitor-table-scroll">
              <table className="tracking-table">
                <thead>
                  <tr>
                    {[
                      'Content',
                      'Type',
                      'Status',
                      'Citations',
                      'Lift',
                      'Engines',
                      'Pickup',
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...groups].flatMap(([key, items]) => [
                    ...(key
                      ? [
                          <tr className="tracking-group" key={`group-${key}`}>
                            <th colSpan={7}>
                              {group === 'month'
                                ? new Date(
                                    `${key}-01T12:00:00Z`,
                                  ).toLocaleDateString('en', {
                                    month: 'long',
                                    year: 'numeric',
                                    timeZone: 'UTC',
                                  })
                                : key}
                              <span>{items.length} on this page</span>
                            </th>
                          </tr>,
                        ]
                      : []),
                    ...items.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            className="tracking-content"
                            onClick={() => setSelected(row.id)}
                          >
                            <span className="tracking-site-icon">
                              {safeHost(row.url)
                                .replace(/^www\./, '')
                                .slice(0, 1)
                                .toUpperCase()}
                            </span>
                            <span>
                              <strong>{row.title}</strong>
                              <small>
                                {row.url.replace(/^https?:\/\//, '')}
                              </small>
                              <small>{date(row.publishedAt)}</small>
                            </span>
                            <ArrowUpRight size={15} />
                          </button>
                        </td>
                        <td>
                          <span
                            className={`tracking-type ${row.contentType.toLowerCase()}`}
                          >
                            {row.contentType === 'BLOG'
                              ? 'Blog'
                              : row.contentType === 'SOCIAL'
                                ? 'Social post'
                                : 'Website content'}
                          </span>
                        </td>
                        <td>
                          <span className={`tracking-status ${row.status}`}>
                            {statusLabels[row.status]}
                          </span>
                        </td>
                        <td title="Lifetime source occurrences">
                          <strong>{row.appearances.toLocaleString()}</strong>
                          <Sparkline values={row.series.map((p) => p.count)} />
                        </td>
                        <td title="Lift requires linked content baseline data">
                          —
                        </td>
                        <td>
                          <div className="tracking-engine-list">
                            {row.providers.length
                              ? row.providers.map((p) => (
                                  <span
                                    key={p.provider}
                                    title={`${PROVIDER_LABELS[p.provider]}: ${p.count} matching results`}
                                  >
                                    <ProviderMark provider={p.provider} />
                                  </span>
                                ))
                              : '—'}
                          </div>
                        </td>
                        <td>
                          {row.daysToFirstCitation === null
                            ? '—'
                            : daysLabel(row.daysToFirstCitation)}
                          <small>
                            {row.firstCitedAt
                              ? date(row.firstCitedAt)
                              : 'Awaiting citation'}
                          </small>
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
            <PageControls
              total={list.data!.total}
              page={page}
              pageSize={size}
              onPage={setPage}
              onSize={(n) => {
                setSize(n);
                setPage(0);
              }}
              loading={list.loading}
            />
          </>
        ) : (
          !list.error && (
            <Empty
              title={
                search || status !== 'all'
                  ? 'No matching URLs'
                  : 'Track your first URL'
              }
              description="Add a page or public post. Each scan checks its saved citations for your tracked URLs."
            />
          )
        )}
      </section>
      <p className="monitor-note">
        Publication time starts when tracking is activated. Dates filter that
        time. Citations show lifetime source occurrences; engines and answer
        details use the selected scan period. All dates use UTC.
      </p>
      {adding && (
        <Drawer
          title="Track results"
          onClose={() => {
            if (!busy) setAdding(false);
          }}
        >
          <form className="form-stack" onSubmit={add}>
            <p>
              Track any website, article, or public social post. Just paste its
              URL.
            </p>
            <ErrorNotice error={error} />
            <label className="field">
              URL
              <input
                autoFocus
                required
                type="url"
                maxLength={2048}
                placeholder="https://example.com/page"
                value={url}
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
              />
              <small>
                Future scans check this exact page and ignore attribution
                parameters.
              </small>
            </label>
            <button className="tracking-add" disabled={busy || !url.trim()}>
              {busy ? 'Activating…' : 'Activate tracking'}
            </button>
          </form>
        </Drawer>
      )}
      {selected && (
        <TrackingDetailDrawer
          path={path}
          id={selected}
          selection={selection}
          revision={currentRevision}
          owner={project.role === 'owner'}
          onChanged={() => refresh((r) => r + 1)}
          onClose={() => setSelected(undefined)}
          onResponse={(id) => {
            setSelected(undefined);
            onResponse(id);
          }}
        />
      )}
    </div>
  );
}
export function TrackingDetailDrawer({
  path,
  id,
  selection,
  revision,
  onClose,
  onResponse,
  owner = false,
  onChanged,
}: {
  path: string;
  id: string;
  selection: MonitorSelection;
  revision: number;
  onClose: () => void;
  onResponse: (id: string) => void;
  owner?: boolean;
  onChanged?: () => void;
}) {
  const [page, setPage] = useState(0),
    [size, setSize] = useState(25),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  const detail = useApi<TrackingDetail>(
      `${path}/tracked-urls/${id}${selectionQuery(selection)}`,
      revision,
    ),
    answers = useApi<AnswerPage>(
      `${path}/tracked-urls/${id}/answers${selectionQuery(selection, { page, pageSize: size })}`,
      revision,
    );
  const row = detail.data?.row;
  async function toggle() {
    if (!row) return;
    setBusy(true);
    setError(undefined);
    try {
      await request(`${path}/tracked-urls/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: row.version, active: !row.active }),
      });
      onChanged?.();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer title="Tracking details" onClose={onClose} wide>
      <ErrorNotice error={detail.error || answers.error || error} />
      {!row ? (
        detail.loading && <Spinner label="Loading URL evidence…" />
      ) : (
        <>
          <div className="tracking-detail-title">
            <span className={`tracking-status ${row.status}`}>
              {statusLabels[row.status]}
            </span>
            {!row.active && <span>Paused</span>}
            <h2>{row.title}</h2>
            <a href={row.url} target="_blank" rel="noopener noreferrer">
              {row.url}
              <ArrowUpRight size={15} />
            </a>
            {owner && (
              <button
                className="button button-outline"
                disabled={busy}
                onClick={() => void toggle()}
              >
                {busy
                  ? 'Saving…'
                  : row.active
                    ? 'Pause tracking'
                    : 'Resume tracking'}
              </button>
            )}
          </div>
          <div className="tracking-timeline">
            <div>
              <Check size={16} />
              <strong>Published</strong>
              <span>{date(row.publishedAt)}</span>
            </div>
            <div>
              <span className="timeline-dot" />
              <strong>Crawled by AI</strong>
              <span>Data unavailable</span>
            </div>
            <div>
              {row.firstCitedAt ? (
                <Check size={16} />
              ) : (
                <span className="timeline-dot" />
              )}
              <strong>First citation</strong>
              <span>{date(row.firstCitedAt)}</span>
            </div>
          </div>
          <div className="tracking-detail-metrics">
            <div>
              <small>Lifetime appearances</small>
              <strong>{row.appearances}</strong>
            </div>
            <div>
              <small>Answers in this period</small>
              <strong>{row.matchingAnswers}</strong>
            </div>
            <div>
              <small>Matching results</small>
              <strong>{row.matchingResults}</strong>
            </div>
            <div>
              <small>Native citations</small>
              <strong>{row.nativeCitations}</strong>
            </div>
            <div>
              <small>Average position</small>
              <strong>{detail.data?.avgPosition ?? '—'}</strong>
            </div>
            <div>
              <small>Sentiment</small>
              <strong>{detail.data?.sentimentScore ?? '—'}</strong>
            </div>
          </div>
          <p className="monitor-note">
            A URL can appear several times in an answer or in several company
            results. Each original answer is counted once in “Answers”.
            Reanalysis and retries do not create extra appearances.
          </p>
          <section className="tracking-detail-section">
            <h3>Citations over time</h3>
            <Sparkline values={row.series.map((p) => p.count)} />
            {row.series.length ? (
              <div className="tracking-date-counts">
                {row.series.map((p) => (
                  <span key={p.date}>
                    {date(p.date)} <b>{p.count}</b>
                  </span>
                ))}
              </div>
            ) : (
              <p>No citations in this period.</p>
            )}
          </section>
          <section className="tracking-detail-section">
            <h3>AI engines</h3>
            {row.providers.map((p) => (
              <div className="tracking-provider-bar" key={p.provider}>
                <ProviderMark provider={p.provider} />
                <span>{PROVIDER_LABELS[p.provider]}</span>
                <i>
                  <b
                    style={{
                      width: `${p.share * 100}%`,
                      background: providerColors[p.provider],
                    }}
                  />
                </i>
                <strong>
                  {p.count} · {Math.round(p.share * 100)}%
                </strong>
              </div>
            ))}
            {!row.providers.length && (
              <p>No analyzed matching results in this period.</p>
            )}
          </section>
          <section className="tracking-detail-section">
            <h3>Prompts citing this URL</h3>
            {detail.data?.prompts.map((p) => (
              <div className="tracking-prompt" key={`${p.id}-${p.provider}`}>
                <span>{p.text}</span>
                <span>
                  {PROVIDER_LABELS[p.provider]} · {p.answers} answers
                </span>
              </div>
            ))}
            {!detail.data?.prompts.length && (
              <p>No matching prompts in this period.</p>
            )}
          </section>
          <section className="monitor-card">
            <header>
              <h2>Matching answers</h2>
            </header>
            {answers.loading && !answers.data ? (
              <Spinner label="Loading matching answers…" />
            ) : answers.data?.items.length ? (
              <>
                <AnswerTable
                  rows={answers.data.items}
                  onResponse={onResponse}
                />
                <PageControls
                  total={answers.data.total}
                  page={page}
                  pageSize={size}
                  onPage={setPage}
                  onSize={(n) => {
                    setSize(n);
                    setPage(0);
                  }}
                  loading={answers.loading}
                />
              </>
            ) : (
              <Empty
                title="No matching answers yet"
                description="Tracking checks every future scan. Try a wider date range for older evidence."
              />
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
