import { Skeleton } from './Loading';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  CalendarDays,
  ChevronDown,
  Download,
  Globe2,
  Hexagon,
  ListFilter,
  Pencil,
  RotateCcw,
  Search,
  Tag,
  TerminalSquare,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  JOURNEY_STAGES,
  MAX_BRANDED_PROMPTS,
  PROMPT_INTENTS,
  PROVIDER_LABELS,
  SCAN_PROVIDERS,
  type JourneyStage,
  type Project,
  type Prompt,
  type PromptIntent,
  type PromptMetricsResponse,
  type PromptMetricsRow,
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

type Props = {
  path: string;
  revision: number;
  onSaved: () => void;
  notify: (text: string) => void;
};
type SortKey =
  | 'text'
  | 'avgVisibility'
  | 'avgSentimentScore'
  | 'avgRank'
  | 'createdAt';
const PAGE_SIZE = 20;

function Filter({
  label,
  icon,
  value,
  onChange,
  children,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className={`prompt-filter-pill ${value ? 'is-filtered' : ''}`}>
      {icon}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={15} />
    </label>
  );
}
export function PromptMetricChange({ value }: { value: number | null }) {
  return (
    <span
      className={`prompt-trend ${value === null ? 'unavailable' : value > 0 ? 'improved' : value < 0 ? 'declined' : ''}`}
      title={
        value === null
          ? 'No comparable measurement in the previous period'
          : 'Change from the previous equal-length period'
      }
    >
      {value !== null &&
        value !== 0 &&
        (value > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />)}
      {value === null
        ? '—'
        : value === 0
          ? '0%'
          : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}
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
  revision,
  onSaved,
  notify,
}: Props) {
  const [days, setDays] = useState('7'),
    [provider, setProvider] = useState('');
  const [search, setSearch] = useState(''),
    [region, setRegion] = useState(''),
    [tag, setTag] = useState('');
  const [branded, setBranded] = useState(''),
    [intent, setIntent] = useState(''),
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
  const account = useApi<Project>(`${path}/settings`, revision);
  const scores = useApi<PromptMetricsResponse>(
    `${path}/prompt-metrics${query({ days, provider })}`,
    revision,
  );
  const project = account.data;
  if (!project)
    return (
      <div className="prompts-screen">
        <div className="prompts-filter-header"><h1>Prompts</h1></div>
        <ErrorNotice error={account.error} />
        {account.loading && <Skeleton variant="table" label="Loading prompts…" />}
      </div>
    );
  const active = project.prompts.filter((prompt) => prompt.active).length;
  const pendingSetup = Boolean(
    project.onboardingJobId && !project.onboardingAppliedJobId,
  );
  const owner = project.role === 'owner',
    editable = owner && !pendingSetup;
  const tags = [
    ...new Set(project.prompts.flatMap((prompt) => prompt.tags || [])),
  ].sort();
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
        };
  });
  const filtered = rows
    .filter(
      (prompt) =>
        (status === 'all' || prompt.active === (status === 'active')) &&
        (!region || prompt.regions.includes(region)) &&
        (!tag || prompt.tags?.includes(tag)) &&
        (!branded || prompt.branded === (branded === 'true')) &&
        (!intent || prompt.intent === intent) &&
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
          <Filter
            label="Regions"
            icon={<Globe2 size={17} />}
            value={region}
            onChange={(value) => filter(() => setRegion(value))}
          >
            <option value="">Regions</option>
            <option value={project.country}>
              {flag(project.country)} {project.country}
            </option>
          </Filter>
          <Filter
            label="Tags"
            icon={<Tag size={17} />}
            value={tag}
            onChange={(value) => filter(() => setTag(value))}
          >
            <option value="">Tags</option>
            {tags.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Filter>
          <Filter
            label="Branded"
            icon={<Hexagon size={17} />}
            value={branded}
            onChange={(value) => filter(() => setBranded(value))}
          >
            <option value="">Branded</option>
            <option value="true">Branded</option>
            <option value="false">Non-branded</option>
          </Filter>
          <Filter
            label="Prompt Types"
            icon={<TerminalSquare size={17} />}
            value={intent}
            onChange={(value) => filter(() => setIntent(value))}
          >
            <option value="">Prompt Types</option>
            {PROMPT_INTENTS.map((value) => (
              <option key={value} value={value}>
                {labelize(value)}
              </option>
            ))}
          </Filter>
          <Filter
            label="Providers"
            icon={<Box size={17} />}
            value={provider}
            onChange={(value) => filter(() => setProvider(value))}
          >
            <option value="">Providers</option>
            {SCAN_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_LABELS[value]}
              </option>
            ))}
          </Filter>
          <Filter
            label="Date range"
            icon={<CalendarDays size={17} />}
            value={days}
            onChange={(value) => filter(() => setDays(value))}
          >
            {[7, 30, 90].map((value) => (
              <option key={value} value={String(value)}>
                Last {value} days
              </option>
            ))}
          </Filter>
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
            <Filter
              label="Prompt status"
              icon={<ListFilter size={17} />}
              value={status}
              onChange={(value) => filter(() => setStatus(value))}
            >
              <option value="active">Active prompts</option>
              <option value="archived">Archived prompts</option>
              <option value="all">All prompts</option>
            </Filter>
          </div>
        </div>
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
                  (status === 'archived' && active + mutationTargets.length > 50)
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
                          <PromptMetricChange value={prompt.visibilityChange} />
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
                          <PromptMetricChange value={prompt.sentimentChange} />
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
                          <PromptMetricChange value={prompt.rankChange} />
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
        Averages for the last {days} days. Changes compare the preceding {days}{' '}
        days. <span>— means no measurement or comparable baseline.</span>
      </p>
      {answerPrompt && (
        <PromptAnswersDrawer
          key={answerPrompt.id}
          path={path}
          prompt={answerPrompt}
          revision={revision}
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
