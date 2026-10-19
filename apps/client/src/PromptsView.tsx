import { useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowUpRight,
  Download,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';
import { JOURNEY_STAGES } from '@citevia/core';
import type {
  JourneyStage,
  Page,
  Project,
  Prompt,
  PromptResult,
  ScanRun,
} from '@citevia/core';
import { downloadCsv, query, request, useApi } from './api';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  formatDate,
  labelize,
  Pagination,
  Spinner,
} from './components';
import { promptObservation } from './prompt-observation';
import './prompts.css';

type Props = {
  path: string;
  revision: number;
  run?: ScanRun | null;
  onSaved: () => void;
  notify: (text: string) => void;
  onResponse: (id: string) => void;
};

export default function PromptsView({
  path,
  revision,
  run,
  onSaved,
  notify,
  onResponse,
}: Props) {
  const account = useApi<Project>(`${path}/settings`, revision);
  const observations = useApi<Page<PromptResult>>(
    run ? `${path}/responses${query({ runId: run.id, limit: 100 })}` : null,
    revision,
  );
  const [search, setSearch] = useState(''),
    [stage, setStage] = useState(''),
    [status, setStatus] = useState('active');
  const [topic, setTopic] = useState(''),
    [branded, setBranded] = useState(''),
    [sort, setSort] = useState('created');
  const [page, setPage] = useState(0),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<Prompt>();
  const [busy, setBusy] = useState<string>(),
    [error, setError] = useState<Error>();
  const project = account.data;
  if (!project)
    return (
      <>
        <ErrorNotice error={account.error} />
        {account.loading && <Spinner label="Loading prompts…" />}
      </>
    );
  const prompts = project.prompts,
    active = prompts.filter((p) => p.active).length;
  const pendingSetup = Boolean(
    project.onboardingJobId && !project.onboardingAppliedJobId,
  );
  const owner = project.role === 'owner',
    editable = owner && !pendingSetup;
  const topics = [
    ...new Set(prompts.map((p) => p.topic).filter((t): t is string => !!t)),
  ].sort();
  const resultFor = (p: Prompt) =>
    promptObservation(
      p,
      project,
      run,
      observations.data?.items.find((r) => r.promptId === p.id),
    );
  let filtered = prompts.filter(
    (p) =>
      (!stage || p.stage === stage) &&
      (status === 'all' || p.active === (status === 'active')) &&
      (!topic || p.topic === topic) &&
      (!branded || p.branded === (branded === 'true')) &&
      `${p.text} ${p.topic || ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  filtered = [...filtered].sort((a, b) =>
    sort === 'text'
      ? a.text.localeCompare(b.text)
      : sort === 'section'
        ? JOURNEY_STAGES.indexOf(a.stage!) - JOURNEY_STAGES.indexOf(b.stage!)
        : sort === 'rank'
          ? (resultFor(a)?.target?.explicitRank ?? Infinity) -
            (resultFor(b)?.target?.explicitRank ?? Infinity)
          : a.createdAt.localeCompare(b.createdAt),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 20) - 1),
  );
  function filter(action: () => void) {
    action();
    setPage(0);
  }
  async function toggle(prompt: Prompt) {
    setBusy(prompt.id);
    setError(undefined);
    try {
      await request(`${path}/prompts/${encodeURIComponent(prompt.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: prompt.version,
          active: !prompt.active,
        }),
      });
      notify(
        prompt.active
          ? 'Prompt archived. Past answers are preserved.'
          : 'Prompt activated for the next scan.',
      );
      onSaved();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(undefined);
    }
  }
  function exportPrompts() {
    downloadCsv(
      'citevia-prompts.csv',
      [
        'ID',
        'Prompt',
        'Section',
        'Topic',
        'Branded',
        'Status',
        'Version',
        'Scan date',
        'Visibility (%)',
        'Explicit rank',
        'Sentiment',
        'Citations',
      ],
      filtered.map((p) => {
        const r = resultFor(p),
          target = r?.status === 'succeeded' ? r.target : undefined;
        return [
          p.id,
          p.text,
          p.stage,
          p.topic,
          String(p.branded),
          p.active ? 'active' : 'archived',
          p.version,
          r ? run?.createdAt : undefined,
          target ? (target.mentioned ? 100 : 0) : null,
          target?.explicitRank,
          target?.sentiment,
          r?.capturedAt ? r.citationCount : null,
        ];
      }),
    );
    notify('Filtered prompts exported.');
  }
  return (
    <>
      <ErrorNotice error={account.error || error} />
      <ErrorNotice error={observations.error} />
      <div className="prompts-overview">
        <div>
          <strong>
            {active}
            <small> / 50</small>
          </strong>
          <span>Active prompts</span>
        </div>
        <div>
          <strong>{prompts.length - active}</strong>
          <span>Archived prompts</span>
        </div>
        <div className="prompts-overview-note">
          One ChatGPT answer per active prompt each week.
          <br />
          {run
            ? `Measurements from ${formatDate(run.createdAt, true)}.`
            : 'Results appear after your first scan.'}
        </div>
      </div>
      <div className="journey-filters" aria-label="Prompt sections">
        {[
          { value: '', label: 'All sections' },
          ...JOURNEY_STAGES.map((value) => ({ value, label: labelize(value) })),
        ].map((item) => (
          <button
            key={item.value}
            className={stage === item.value ? 'selected' : ''}
            aria-pressed={stage === item.value}
            onClick={() => filter(() => setStage(item.value))}
          >
            {item.label}
            <span>
              {
                prompts.filter(
                  (p) => p.active && (!item.value || p.stage === item.value),
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Your prompts</h2>
            <p className="card-description">
              Manage the questions your customers ask ChatGPT
            </p>
          </div>
          <div className="prompt-actions">
            <button
              className="button button-outline"
              onClick={exportPrompts}
              disabled={!filtered.length}
            >
              <Download size={13} />
              Export
            </button>
            {owner && (
              <button
                className="button button-primary"
                disabled={!editable || active >= 50}
                onClick={() => setAdding(true)}
              >
                <Plus size={13} />
                Add prompts
              </button>
            )}
          </div>
        </div>
        {pendingSetup && (
          <p className="prompt-notice">
            Account setup is preparing your portfolio. Finish setup in Accounts
            before editing prompts.
          </p>
        )}
        {!owner && (
          <p className="prompt-notice">
            You have view access. A project owner can manage prompts.
          </p>
        )}
        <div className="filter-bar prompt-filters">
          <label className="search-box">
            <Search size={14} />
            <input
              aria-label="Search prompts"
              type="search"
              placeholder="Search prompts or topics…"
              value={search}
              onChange={(e) => filter(() => setSearch(e.target.value))}
            />
          </label>
          <select
            aria-label="Prompt status"
            value={status}
            onChange={(e) => filter(() => setStatus(e.target.value))}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All statuses</option>
          </select>
          <select
            aria-label="Prompt topic"
            value={topic}
            onChange={(e) => filter(() => setTopic(e.target.value))}
          >
            <option value="">All topics</option>
            {topics.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            aria-label="Branded prompts"
            value={branded}
            onChange={(e) => filter(() => setBranded(e.target.value))}
          >
            <option value="">All prompts</option>
            <option value="true">Branded</option>
            <option value="false">Discovery</option>
          </select>
          <select
            aria-label="Sort prompts"
            value={sort}
            onChange={(e) => filter(() => setSort(e.target.value))}
          >
            <option value="created">Date added</option>
            <option value="text">Prompt A–Z</option>
            <option value="section">Section</option>
            <option value="rank">Rank</option>
          </select>
        </div>
        {!filtered.length ? (
          <Empty
            title={prompts.length ? 'No matching prompts' : 'No prompts yet'}
            description={
              prompts.length
                ? 'Change the section, search or status filters to see other prompts.'
                : pendingSetup
                  ? 'Your prompts will appear as account setup completes.'
                  : 'Add the questions you want to track. Results stay empty until a real scan completes.'
            }
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table prompts-table">
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>Section</th>
                    <th>Visibility</th>
                    <th>Rank</th>
                    <th>Sentiment</th>
                    <th>Citations</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered
                    .slice(currentPage * 20, (currentPage + 1) * 20)
                    .map((p) => {
                      const result = resultFor(p),
                        target =
                          result?.status === 'succeeded'
                            ? result.target
                            : undefined;
                      const historical =
                        observations.data?.items.some(
                          (r) => r.promptId === p.id,
                        ) && !result;
                      return (
                        <tr
                          key={p.id}
                          className={!p.active ? 'prompt-archived' : ''}
                        >
                          <td className="prompt-cell">
                            <span className="prompt-name" dir="auto">
                              {p.text}
                            </span>
                            <span className="prompt-category">
                              {p.topic ? `${p.topic} · ` : ''}
                              {p.branded ? 'Branded' : 'Discovery'} · v
                              {p.version} · {p.active ? 'Active' : 'Archived'}
                            </span>
                            {historical && (
                              <small className="prompt-measurement-note">
                                Changed since this scan
                              </small>
                            )}
                          </td>
                          <td>{p.stage ? <Badge value={p.stage} /> : '—'}</td>
                          <td>
                            {target ? (
                              <Badge
                                value={
                                  target.mentioned ? 'positive' : 'neutral'
                                }
                                label={
                                  target.mentioned
                                    ? '100% · Mentioned'
                                    : '0% · Absent'
                                }
                              />
                            ) : (
                              '—'
                            )}
                            {result && !target && (
                              <small className="prompt-measurement-note">
                                {labelize(result.status)}
                              </small>
                            )}
                          </td>
                          <td>
                            <span className="rank">
                              {target?.explicitRank != null
                                ? `#${target.explicitRank}`
                                : '—'}
                            </span>
                          </td>
                          <td>
                            {target ? (
                              <Badge
                                value={
                                  target.mentioned
                                    ? target.sentiment
                                    : 'not_applicable'
                                }
                              />
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {result?.capturedAt ? result.citationCount : '—'}
                          </td>
                          <td>
                            <div className="prompt-actions">
                              {result && (
                                <button
                                  className="icon-button"
                                  aria-label={`Read answer to ${p.text}`}
                                  title="Read original answer"
                                  onClick={() => onResponse(result.responseId)}
                                >
                                  <ArrowUpRight size={15} />
                                </button>
                              )}
                              {owner && (
                                <>
                                  <button
                                    className="icon-button"
                                    disabled={!editable || !!busy}
                                    aria-label={`Edit prompt: ${p.text}`}
                                    title="Edit prompt"
                                    onClick={() => setEditing(p)}
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    disabled={
                                      !editable ||
                                      !!busy ||
                                      (!p.active && active >= 50)
                                    }
                                    aria-label={`${p.active ? 'Archive' : 'Activate'} prompt: ${p.text}`}
                                    title={
                                      p.active
                                        ? 'Archive prompt'
                                        : active >= 50
                                          ? 'Archive another prompt to free a slot'
                                          : 'Activate prompt'
                                    }
                                    onClick={() => void toggle(p)}
                                  >
                                    {p.active ? (
                                      <Archive size={14} />
                                    ) : (
                                      <RotateCcw size={14} />
                                    )}
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={currentPage}
              total={filtered.length}
              size={20}
              onChange={setPage}
            />
          </>
        )}
      </section>
      <p className="scan-options">
        Visibility is 100% or 0% for the single answer in the selected weekly
        scan. Missing or failed analysis stays blank. Rank requires an explicit
        recommendation position. Editing a prompt creates a new version; past
        answers remain in Mentions.
      </p>
      {(adding || editing) && (
        <PromptEditor
          key={editing?.id || 'add'}
          path={path}
          prompt={editing}
          slots={50 - active}
          onClose={() => {
            setAdding(false);
            setEditing(undefined);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(undefined);
            onSaved();
          }}
          notify={notify}
        />
      )}
    </>
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
  const [topic, setTopic] = useState(prompt?.topic || ''),
    [branded, setBranded] = useState(prompt?.branded || false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<Error>();
  const texts = text
    .split(/\r?\n/)
    .map((t) => t.trim())
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
            topic,
            branded,
          }),
        },
      );
      notify(
        prompt
          ? 'Prompt saved. Changes apply to the next scan.'
          : `${texts.length} prompts added for the next scan.`,
      );
      onSaved();
    } catch (error) {
      setError(error as Error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Drawer
      title={prompt ? 'Edit prompt' : 'Add prompts'}
      onClose={saving ? () => {} : onClose}
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)}>
        <ErrorNotice error={error} />
        <fieldset className="prompt-fieldset" disabled={saving}>
          <label className="field">
            {prompt ? 'Prompt' : 'One prompt per line'}
            <textarea
              rows={7}
              required
              maxLength={prompt ? 2000 : 102000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {!prompt && (
              <small>
                {texts.length} prompts · {slots} available slots
              </small>
            )}
          </label>
          <label className="field">
            Section
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as JourneyStage)}
            >
              {JOURNEY_STAGES.map((value) => (
                <option value={value} key={value}>
                  {labelize(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Topic
            <input
              value={topic}
              maxLength={120}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={branded}
              onChange={(e) => setBranded(e.target.checked)}
            />
            Includes your brand name
          </label>
          <p className="scan-options">
            Saving changes your prompt portfolio. Start a scan to collect new
            answers.
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
                    texts.some((t) => t.length < 3 || t.length > 2000))
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
