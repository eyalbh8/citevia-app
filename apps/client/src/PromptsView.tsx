import { Skeleton } from './Loading';
import { useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Download,
  Globe2,
  Hexagon,
  ListFilter,
  Pencil,
  RotateCcw,
  Search,
  TerminalSquare,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  JOURNEY_STAGES,
  MAX_BRANDED_PROMPTS,
  PROMPT_INTENTS,
  type ScanProvider,
  type JourneyStage,
  type Project,
  type Prompt,
  type PromptIntent,
  type PromptMetricsResponse,
  type PromptMetricsRow,
  type PromptMetricComparison,
} from '@citevia/core';
import { downloadCsv, query, request, useApi } from './api';
import {
  Drawer,
  Empty,
  ErrorNotice,
  formatDate,
  labelize,
  Pagination,
} from './components';
import PromptAnswersDrawer from './PromptAnswersDrawer';
import './prompts.css';
import ProviderFilter from './ProviderFilter';
import FilterDropdown from './FilterDropdown';
import {
  brandingOptions,
  promptTypeOptions,
  regionOptions,
} from './filter-options';
import DateRangeFilter, { initialDateRange, type DateRangeSelection } from './DateRangeFilter';

type Props = {
  path: string;
  demo?: Project['demo'];
  onSaved: () => void;
  notify: (text: string) => void;
};
type SortKey =
  'text' | 'avgVisibility' | 'avgSentimentScore' | 'avgRank' | 'createdAt';
const PAGE_SIZE = 20;

export function PromptMetricChange({
  value,
  comparison,
  metric = 'visibility',
}: {
  value: number | null;
  comparison?: PromptMetricComparison | null;
  metric?: 'visibility' | 'sentiment' | 'rank';
}) {
  const shown = value === null
    ? '—'
    : value === 0 ? '0%' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  const dates = (range: { start: string; end: string }) => {
    const start = range.start.slice(0, 10),
      end = range.end.slice(0, 10);
    return start === end ? start : `${start}–${end}`;
  };
  const basis = comparison
    ? comparison.mode === 'first_last_day'
      ? `First to latest scan day: ${dates(comparison.baseline)} → ${dates(comparison.current)} UTC. ${comparison.providers.length} matched provider${comparison.providers.length === 1 ? '' : 's'}, one answer per provider on each day. Values above average the entire selected period.`
      : `Previous equal-length period: ${dates(comparison.baseline)} → ${dates(comparison.current)} UTC. ${comparison.baseline.measurementCount} → ${comparison.current.measurementCount} analyzed answers.`
    : 'Needs comparable measurements in the previous period or on two distinct scan days in this period.';
  const description = `${value === null ? 'No comparable score. ' : ''}${basis} Relative percent change${metric === 'visibility' ? ', not percentage points' : ''}. ${metric === 'rank' ? 'Positive means a lower, better rank.' : 'A zero baseline rising above zero is shown as +100%.'}`;
  return (
    <span
      className={`prompt-trend ${value === null ? 'unavailable' : value > 0 ? 'improved' : value < 0 ? 'declined' : ''}`}
      title={description}
      role="img"
      aria-label={`${labelize(metric)} change: ${shown}. ${description}`}
    >
      {value !== null &&
        value !== 0 &&
        (value > 0
          ? <TrendingUp size={13} aria-hidden="true" />
          : <TrendingDown size={13} aria-hidden="true" />)}
      {shown}
    </span>
  );
}
export function VisibilityGauge({ value }: { value: number | null }) {
  if (value === null)
    return (
      <span
        className="prompt-missing"
        title="No successfully analyzed answers in this period"
      >
        —
      </span>
    );
  return (
    <svg
      className="prompt-visibility-gauge"
      viewBox="0 0 76 48"
      role="img"
      aria-label={`Visibility ${value}%`}
    >
      <path
        className="gauge-track"
        d="M 10 38 A 28 28 0 0 1 66 38"
        pathLength="100"
      />
      <path
        className="gauge-value"
        d="M 10 38 A 28 28 0 0 1 66 38"
        pathLength="100"
        strokeDasharray={`${Math.max(0, Math.min(100, value))} 100`}
      />
      <text x="38" y="36" textAnchor="middle">
        {value}%
      </text>
    </svg>
  );
}
function flag(country: string) {
  return /^[A-Z]{2}$/.test(country)
    ? String.fromCodePoint(
        ...[...country].map((letter) => 127397 + letter.charCodeAt(0)),
      )
    : '';
}
export default function PromptsView({
  path,
  onSaved,
  notify,
  demo,
}: Props) {
  const [dateRange, setDateRange] = useState<DateRangeSelection>(() => initialDateRange(demo)),
    [provider, setProvider] = useState<ScanProvider | ''>('');
  const [search, setSearch] = useState(''),
    [region, setRegion] = useState('');
  const [branded, setBranded] = useState(''),
    [stage, setStage] = useState<JourneyStage | ''>(''),
    [status, setStatus] = useState('active');
  const [sort, setSort] = useState<SortKey>('avgVisibility'),
    [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0),
    [selection, setSelection] = useState<string[]>([]);
  const [answerPrompt, setAnswerPrompt] = useState<Prompt>();
  const [pendingArchive, setPendingArchive] = useState<Prompt[]>();
  const [editing, setEditing] = useState<Prompt>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  const account = useApi<Project>(`${path}/settings`);
  const scores = useApi<PromptMetricsResponse>(
    `${path}/prompt-metrics${query({ days: dateRange.days, provider, start: dateRange.days === 'custom' ? dateRange.start : undefined, end: dateRange.days === 'custom' ? dateRange.end : undefined })}`,
  );
  const project = account.data;
  if (!project)
    return (
      <div className="prompts-screen">
        <div className="prompts-filter-header">
          <h1>Prompts</h1>
        </div>
        <ErrorNotice error={account.error} />
        {account.loading && (
          <Skeleton variant="table" label="Loading prompts…" />
        )}
      </div>
    );
  const active = project.prompts.filter((prompt) => prompt.active).length;
  const pendingSetup = Boolean(
    project.onboardingJobId && !project.onboardingAppliedJobId,
  );
  const owner = project.role === 'owner' && !project.demo,
    editable = owner && !pendingSetup;
  const metricMap = new Map(scores.data?.items.map((row) => [row.id, row]));
  // Never attach a stale measurement to a newly edited question while refreshing.
  const rows: PromptMetricsRow[] = project.prompts.map((prompt) => {
    const metric = metricMap.get(prompt.id);
    return metric?.version === prompt.version && metric.text === prompt.text
      ? metric
      : {
          ...prompt,
          regions: [project.country],
          language: project.language,
          avgVisibility: null,
          avgRank: null,
          avgSentimentScore: null,
          visibilityChange: null,
          sentimentChange: null,
          rankChange: null,
          measurementCount: 0,
          previousMeasurementCount: 0,
          rankCount: 0,
          sentimentCount: 0,
          responseId: null,
          comparison: null,
        };
  });
  const filtered = rows
    .filter(
      (prompt) =>
        (status === 'all' || prompt.active === (status === 'active')) &&
        (!region || prompt.regions.includes(region)) &&
        (!branded || prompt.branded === (branded === 'true')) &&
        (!stage || prompt.stage === stage) &&
        `${prompt.text} ${prompt.seoKeyword || ''} ${(prompt.tags || []).join(' ')}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => {
      const left = a[sort],
        right = b[sort];
      if (left === null || right === null)
        return left === right
          ? a.id.localeCompare(b.id)
          : left === null
            ? 1
            : -1;
      const delta =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return (direction === 'asc' ? delta : -delta) || a.id.localeCompare(b.id);
    });
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const selected = filtered.filter((prompt) => selection.includes(prompt.id));
  const allSelected =
    visible.length > 0 &&
    visible.every((prompt) => selection.includes(prompt.id));
  function filter(action: () => void) {
    action();
    setPage(0);
    setSelection([]);
  }
  function sortBy(key: SortKey) {
    setSort(key);
    setDirection(
      sort === key
        ? direction === 'desc'
          ? 'asc'
          : 'desc'
        : key === 'text' || key === 'avgRank'
          ? 'asc'
          : 'desc',
    );
    setPage(0);
  }
  function sortHeader(label: string, key: SortKey) {
    return (
      <th
        scope="col"
        aria-sort={
          sort === key
            ? direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
        }
      >
        <button
          className={`prompt-sort ${sort === key ? 'sorted' : ''}`}
          onClick={() => sortBy(key)}
        >
          {label}
          {sort === key &&
            (direction === 'desc' ? (
              <ArrowDown size={15} />
            ) : (
              <ArrowUp size={15} />
            ))}
        </button>
      </th>
    );
  }
  async function updateStatus(prompts: Prompt[], makeActive: boolean) {
    setBusy(true);
    setError(undefined);
    let saved = 0;
    try {
      for (const prompt of prompts.filter(
        (prompt) => prompt.active !== makeActive,
      )) {
        await request(`${path}/prompts/${encodeURIComponent(prompt.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ version: prompt.version, active: makeActive }),
        });
        saved++;
      }
      setSelection([]);
      notify(
        `${saved} ${saved === 1 ? 'prompt' : 'prompts'} ${makeActive ? 'activated' : 'archived'}.`,
      );
    } catch (cause) {
      setError(
        new Error(
          `${saved ? `${saved} saved. ` : ''}${(cause as Error).message}`,
        ),
      );
    } finally {
      setBusy(false);
      onSaved();
    }
  }
  function exportPrompts() {
    const exported = selected.length ? selected : filtered;
    downloadCsv(
      'citevia-prompts.csv',
      [
        'ID',
        'Prompt',
        'SEO keyword',
        'Regions',
        'Intent',
        'Branded',
        'Visibility (%)',
        'Visibility change (%)',
        'Sentiment',
        'Sentiment change (%)',
        'Rank',
        'Rank change (%)',
        'Created',
        'Tags',
        'Status',
        'Provider',
        'Period start',
        'Period end',
        'Analyzed answers',
        'Previous analyzed answers',
        'Version',
        'Change comparison',
        'Comparison baseline start',
        'Comparison baseline end',
        'Comparison current start',
        'Comparison current end',
        'Comparison baseline answers',
        'Comparison current answers',
        'Comparison providers',
      ],
      exported.map((prompt) => [
        prompt.id,
        prompt.text,
        prompt.seoKeyword,
        prompt.regions.join(', '),
        prompt.intent,
        String(prompt.branded),
        prompt.avgVisibility,
        prompt.visibilityChange,
        prompt.avgSentimentScore,
        prompt.sentimentChange,
        prompt.avgRank,
        prompt.rankChange,
        prompt.createdAt,
        prompt.tags?.join(', '),
        prompt.active ? 'active' : 'archived',
        provider || 'all',
        scores.data?.period.start,
        scores.data?.period.end,
        prompt.measurementCount,
        prompt.previousMeasurementCount,
        prompt.version,
        prompt.comparison?.mode,
        prompt.comparison?.baseline.start,
        prompt.comparison?.baseline.end,
        prompt.comparison?.current.start,
        prompt.comparison?.current.end,
        prompt.comparison?.baseline.measurementCount,
        prompt.comparison?.current.measurementCount,
        prompt.comparison?.providers.join(', '),
      ]),
    );
    notify(`${exported.length} prompts exported.`);
  }
  const mutationTargets = selected.filter(
    (prompt) => prompt.active === (status !== 'archived'),
  );
  return (
    <div className="prompts-screen">
      <div className="prompts-filter-header">
        <h1>Prompts</h1>
        <div className="prompts-filter-list">
          <FilterDropdown
            label="Regions"
            icon={<Globe2 size={17} />}
            value={region}
            onChange={(value) => filter(() => setRegion(value))}
            placeholder="Regions"
            options={regionOptions(project.country)}
          />
          <FilterDropdown
            label="Branded"
            icon={<Hexagon size={17} />}
            value={branded}
            onChange={(value) => filter(() => setBranded(value))}
            placeholder="Branded"
            options={brandingOptions}
          />
          <FilterDropdown
            label="Prompt Types"
            icon={<TerminalSquare size={17} />}
            value={stage}
            onChange={(value) =>
              filter(() => setStage(value as JourneyStage | ''))
            }
            placeholder="Prompt Types"
            options={promptTypeOptions}
          />
          <ProviderFilter
            project={project}
            value={provider ? [provider] : []}
            onChange={(providers) =>
              filter(() => setProvider(providers[0] || ''))
            }
          />
          <DateRangeFilter
            value={dateRange}
            onChange={(range) => filter(() => setDateRange(range))}
            includeLast24Hours={false}
            demo={project.demo}
          />
        </div>
      </div>
      <ErrorNotice error={account.error || error} />
      <ErrorNotice error={scores.error} />
      <section className="prompts-panel" aria-label="Tracked prompts">
        <div className="prompts-toolbar">
          <label className="prompts-search">
            <Search size={23} />
            <input
              type="search"
              aria-label="Search prompts"
              placeholder="Search"
              value={search}
              onChange={(event) => filter(() => setSearch(event.target.value))}
            />
          </label>
          <span className="prompts-usage">
            {scores.data?.usage.active ?? active} out of{' '}
            {scores.data?.usage.limit ?? 50} Prompts Used
          </span>
          <div className="prompts-status-filter">
            <FilterDropdown
              label="Prompt status"
              icon={<ListFilter size={17} />}
              value={status}
              onChange={(value) => filter(() => setStatus(value))}
              options={[
                { value: 'active', label: 'Active prompts' },
                { value: 'archived', label: 'Archived prompts' },
                { value: 'all', label: 'All prompts' },
              ]}
            />
          </div>
        </div>
        <p className="prompt-comparison-note">
          Values average the selected period. Percentage changes compare the previous period,
          or the first and latest scan days when earlier data is unavailable.
        </p>
        {pendingSetup && (
          <p className="prompt-notice">
            Account setup is preparing your prompts. You can edit them when
            setup finishes.
          </p>
        )}
        {!owner && (
          <p className="prompt-notice">
            You have view access. A project owner can manage prompts.
          </p>
        )}
        {selected.length > 0 && (
          <div className="prompt-selection" role="status">
            <span>{selected.length} selected</span>
            <button
              disabled={scores.loading || !!scores.error}
              onClick={exportPrompts}
            >
              <Download size={16} /> Export selected
            </button>
            {owner && (
              <button
                disabled={
                  !editable ||
                  busy ||
                  !mutationTargets.length ||
                  (status === 'archived' &&
                    active + mutationTargets.length > 50)
                }
                onClick={() => {
                  if (status === 'archived')
                    void updateStatus(mutationTargets, true);
                  else setPendingArchive(mutationTargets);
                }}
              >
                {status === 'archived' ? (
                  <RotateCcw size={16} />
                ) : (
                  <Archive size={16} />
                )}
                {status === 'archived' ? 'Activate' : 'Archive'} selected
              </button>
            )}
            <button onClick={() => setSelection([])}>Clear selection</button>
          </div>
        )}
        {scores.loading && !scores.data ? (
          <Skeleton variant="table" label="Loading prompt measurements…" />
        ) : !filtered.length ? (
          <Empty
            title={rows.length ? 'No matching prompts' : 'No prompts yet'}
            description={
              rows.length
                ? 'Change your search or filters to see more prompts.'
                : pendingSetup
                  ? 'Your prompts will appear when account setup finishes.'
                  : 'Your prompts will appear after account setup.'
            }
          />
        ) : (
          <>
            <div className="table-scroll" aria-busy={scores.loading}>
              <table className="prompts-table">
                <thead>
                  <tr>
                    <th className="prompt-check-cell" scope="col">
                      <input
                        type="checkbox"
                        aria-label="Select all prompts on this page"
                        checked={allSelected}
                        ref={(node) => {
                          if (node)
                            node.indeterminate =
                              !allSelected &&
                              visible.some((prompt) =>
                                selection.includes(prompt.id),
                              );
                        }}
                        onChange={() =>
                          setSelection(
                            allSelected
                              ? selection.filter(
                                  (id) =>
                                    !visible.some((prompt) => prompt.id === id),
                                )
                              : [
                                  ...new Set([
                                    ...selection,
                                    ...visible.map((prompt) => prompt.id),
                                  ]),
                                ],
                          )
                        }
                      />
                    </th>
                    {sortHeader('Prompts', 'text')}
                    <th scope="col">SEO keyword</th>
                    <th scope="col">
                      <span
                        className="prompt-heading-hint"
                        title="Region used to collect answers"
                      >
                        Regions
                      </span>
                    </th>
                    <th scope="col">
                      <span
                        className="prompt-heading-hint"
                        title="Search intent and branded status"
                      >
                        Intent
                      </span>
                    </th>
                    {sortHeader('Visibility', 'avgVisibility')}
                    {sortHeader('Sentiment', 'avgSentimentScore')}
                    {sortHeader('Rank', 'avgRank')}
                    {sortHeader('Created', 'createdAt')}
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((prompt) => (
                    <tr
                      key={prompt.id}
                      className={`${!prompt.active ? 'prompt-archived' : ''} ${selection.includes(prompt.id) ? 'prompt-selected' : ''}`}
                    >
                      <td className="prompt-check-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select prompt: ${prompt.text}`}
                          checked={selection.includes(prompt.id)}
                          onChange={() =>
                            setSelection(
                              selection.includes(prompt.id)
                                ? selection.filter((id) => id !== prompt.id)
                                : [...selection, prompt.id],
                            )
                          }
                        />
                      </td>
                      <td className="prompt-cell">
                        <button
                          className="prompt-name"
                          dir="auto"
                          title="View all saved answers"
                          onClick={() => setAnswerPrompt(prompt)}
                        >
                          {prompt.text}
                        </button>
                        {!prompt.active && (
                          <small className="prompt-measurement-note">
                            Archived
                          </small>
                        )}
                      </td>
                      <td className="prompt-keyword" dir="auto">
                        {prompt.seoKeyword || '—'}
                      </td>
                      <td>
                        <span className="prompt-region">
                          <span aria-hidden="true">
                            {flag(project.country)}
                          </span>
                          {project.country}
                        </span>
                      </td>
                      <td>
                        <div className="prompt-intent">
                          {prompt.intent ? (
                            <span
                              className={`intent-chip intent-${prompt.intent}`}
                              title={labelize(prompt.intent)}
                            >
                              {prompt.intent.charAt(0).toUpperCase()}
                            </span>
                          ) : (
                            <span title="Intent not assigned">—</span>
                          )}
                          <span
                            className="intent-chip intent-branded"
                            title={prompt.branded ? 'Branded' : 'Non-branded'}
                          >
                            {prompt.branded ? 'B' : 'N'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div
                          className="prompt-metric"
                          title={`${prompt.measurementCount} successfully analyzed answers`}
                        >
                          <VisibilityGauge value={prompt.avgVisibility} />
                          <PromptMetricChange
                            value={prompt.visibilityChange}
                            comparison={prompt.comparison}
                          />
                        </div>
                      </td>
                      <td>
                        <div
                          className="prompt-metric"
                          title={`${prompt.sentimentCount} classified brand mentions`}
                        >
                          {prompt.avgSentimentScore === null ? (
                            <span className="prompt-missing">—</span>
                          ) : (
                            <span
                              className={`prompt-sentiment ${prompt.avgSentimentScore >= 60 ? 'positive' : prompt.avgSentimentScore >= 40 ? 'neutral' : 'negative'}`}
                            >
                              {prompt.avgSentimentScore}
                            </span>
                          )}
                          <PromptMetricChange
                            value={prompt.sentimentChange}
                            comparison={prompt.comparison}
                            metric="sentiment"
                          />
                        </div>
                      </td>
                      <td>
                        <div
                          className="prompt-metric"
                          title={`${prompt.rankCount} ranked brand mentions. Lower is better.`}
                        >
                          <span className="prompt-rank">
                            {prompt.avgRank === null
                              ? '—'
                              : Number(prompt.avgRank.toFixed(1))}
                          </span>
                          <PromptMetricChange
                            value={prompt.rankChange}
                            comparison={prompt.comparison}
                            metric="rank"
                          />
                        </div>
                      </td>
                      <td>
                        <time
                          className="prompt-created"
                          dateTime={prompt.createdAt}
                        >
                          <span>{formatDate(prompt.createdAt)}</span>
                          <span>
                            {new Date(prompt.createdAt).getFullYear()}
                          </span>
                        </time>
                      </td>
                      <td>
                        <div className="prompt-actions">
                          <button
                            className="icon-button"
                            aria-label={`View all answers to ${prompt.text}`}
                            title="View all saved answers"
                            onClick={() => setAnswerPrompt(prompt)}
                          >
                            <ArrowUpRight size={16} />
                          </button>
                          {owner && (
                            <>
                              <button
                                className="icon-button"
                                aria-label={`Edit prompt: ${prompt.text}`}
                                title="Edit prompt"
                                disabled={!editable || busy}
                                onClick={() => setEditing(prompt)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="prompt-archive-action"
                                aria-label={`${prompt.active ? 'Archive' : 'Activate'} prompt: ${prompt.text}`}
                                title={
                                  prompt.active
                                    ? 'Archive prompt'
                                    : 'Activate prompt'
                                }
                                disabled={
                                  !editable ||
                                  busy ||
                                  (!prompt.active && active >= 50)
                                }
                                onClick={() =>
                                  prompt.active
                                    ? setPendingArchive([prompt])
                                    : void updateStatus([prompt], true)
                                }
                              >
                                {prompt.active ? (
                                  <Archive size={15} />
                                ) : (
                                  <RotateCcw size={15} />
                                )}
                                {prompt.active ? 'Archive' : 'Activate'}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={currentPage}
              total={filtered.length}
              size={PAGE_SIZE}
              onChange={setPage}
            />
          </>
        )}
      </section>
      <p className="prompts-period-note">
        {dateRange.days === 'custom'
          ? `Averages from ${dateRange.start} through ${dateRange.end} (UTC).`
          : `Averages for the last ${dateRange.days} days.`}{' '}
        Changes compare the preceding equal-length period.{' '}
        <span>— means no measurement or comparable baseline.</span>
      </p>
      {answerPrompt && (
        <PromptAnswersDrawer
          key={answerPrompt.id}
          path={path}
          prompt={answerPrompt}
          initialProvider={provider}
          onClose={() => setAnswerPrompt(undefined)}
        />
      )}
      {pendingArchive && (
        <Drawer
          title="Archive prompts?"
          onClose={() => setPendingArchive(undefined)}
        >
          <div className="prompt-archive-confirm">
            <p>
              Archiving stops future scans for{' '}
              {pendingArchive.length === 1 ? 'this prompt' : 'these prompts'}.
              All saved answers are kept. Choose Archived prompts in the status
              filter to activate them again.
            </p>
            <ul>
              {pendingArchive.map((prompt) => (
                <li key={prompt.id} dir="auto">
                  {prompt.text}
                </li>
              ))}
            </ul>
            <div className="form-actions">
              <button
                className="button button-outline"
                onClick={() => setPendingArchive(undefined)}
              >
                Keep active
              </button>
              <button
                className="button button-primary"
                onClick={() => {
                  const prompts = pendingArchive;
                  setPendingArchive(undefined);
                  void updateStatus(prompts, false);
                }}
              >
                Archive{' '}
                {pendingArchive.length === 1
                  ? 'prompt'
                  : `${pendingArchive.length} prompts`}
              </button>
            </div>
          </div>
        </Drawer>
      )}
      {editing && (
        <PromptEditor
          key={editing.id}
          path={path}
          prompt={editing}
          slots={50 - active}
          onClose={() => {
            setEditing(undefined);
          }}
          onSaved={() => {
            setEditing(undefined);
            onSaved();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function PromptEditor({
  path,
  prompt,
  slots,
  onClose,
  onSaved,
  notify,
}: {
  path: string;
  prompt?: Prompt;
  slots: number;
  onClose: () => void;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [text, setText] = useState(prompt?.text || ''),
    [stage, setStage] = useState<JourneyStage>(prompt?.stage || 'understand');
  const [intent, setIntent] = useState<PromptIntent | ''>(prompt?.intent || '');
  const [seoKeyword, setSeoKeyword] = useState(prompt?.seoKeyword || ''),
    [tags, setTags] = useState(prompt?.tags?.join(', ') || '');
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<Error>();
  const texts = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await request(
        prompt
          ? `${path}/prompts/${encodeURIComponent(prompt.id)}`
          : `${path}/prompts`,
        {
          method: prompt ? 'PATCH' : 'POST',
          body: JSON.stringify({
            ...(prompt
              ? { text: text.trim(), version: prompt.version }
              : { texts }),
            stage,
            ...(intent ? { intent } : {}),
            seoKeyword,
            tags: tags
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          }),
        },
      );
      notify(
        prompt
          ? 'Prompt saved.'
          : `${texts.length} prompts added for the next scan.`,
      );
      onSaved();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Drawer
      title={prompt ? 'Edit prompt' : 'Add prompts'}
      onClose={saving ? () => {} : onClose}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <ErrorNotice error={error} />
        <fieldset className="prompt-fieldset" disabled={saving}>
          <label className="field">
            {prompt ? 'Prompt' : 'One prompt per line'}
            <textarea
              rows={6}
              required
              maxLength={prompt ? 2000 : 102000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {!prompt && (
              <small>
                {texts.length} prompts · {slots} available slots
              </small>
            )}
          </label>
          <label className="field">
            SEO keyword
            <input
              maxLength={160}
              value={seoKeyword}
              onChange={(event) => setSeoKeyword(event.target.value)}
            />
          </label>
          <label className="field">
            Intent
            <select
              value={intent}
              onChange={(event) =>
                setIntent(event.target.value as PromptIntent | '')
              }
            >
              <option value="" disabled>
                Choose intent
              </option>
              {PROMPT_INTENTS.map((value) => (
                <option key={value} value={value}>
                  {labelize(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Section
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value as JourneyStage)}
            >
              {JOURNEY_STAGES.map((value) => (
                <option key={value} value={value}>
                  {labelize(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Tags
            <input
              value={tags}
              maxLength={609}
              placeholder="Priority, Comparison"
              onChange={(event) => setTags(event.target.value)}
            />
            <small>Separate up to 10 tags with commas.</small>
          </label>
          <p className="scan-options">
            Brand names are detected automatically. Up to {MAX_BRANDED_PROMPTS}{' '}
            active prompts may be branded. Edited prompts receive new
            measurements on the next scan.
          </p>
          <div className="form-actions">
            <button
              className="button button-outline"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={
                saving ||
                (prompt
                  ? text.trim().length < 3
                  : !texts.length ||
                    texts.length > slots ||
                    texts.some(
                      (value) => value.length < 3 || value.length > 2000,
                    ))
              }
            >
              {saving ? 'Saving…' : prompt ? 'Save prompt' : 'Add prompts'}
            </button>
          </div>
        </fieldset>
      </form>
    </Drawer>
  );
}
