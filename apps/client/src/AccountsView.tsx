import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  LoaderCircle,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type { OnboardingInput, OnboardingJob, Project } from '@citevia/core';
import { JOURNEY_STAGES } from '@citevia/core';
import { downloadCsv, idempotentPost, useApi, query } from './api';
import { parseAccountImport } from './account-import';
import { Badge, Empty, ErrorNotice, Spinner } from './components';
type Account = Project & {
  activePromptCount?: number;
  onboardingSummary?: Pick<
    OnboardingJob,
    'status' | 'step' | 'error' | 'firstRunId'
  >;
};
export default function AccountsView({
  onOpen,
  providerReady,
  canCreate,
  onChanged,
  notify,
}: {
  canCreate: boolean;
  providerReady: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
  notify: (text: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState(''),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setCursors([undefined]);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const [revision, setRevision] = useState(0),
    [showForm, setShowForm] = useState(false),
    [bulk, setBulk] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  const {
    data,
    error: loadError,
    loading,
  } = useApi<{
    items: Account[];
    mode: string;
    total: number;
    nextCursor: string | null;
  }>(
    `/projects${query({ q: debounced, limit: 25, cursor: cursors.at(-1) })}`,
    revision,
  );
  const filtered = data?.items || [];
  const pending = data?.items.some(
    (p) =>
      p.onboardingSummary &&
      ['queued', 'running'].includes(p.onboardingSummary.status),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [pending]);
  const [name, setName] = useState(''),
    [website, setWebsite] = useState(''),
    [country, setCountry] = useState('US'),
    [language, setLanguage] = useState('en'),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ),
    [description, setDescription] = useState('');
  const [manual, setManual] = useState({
      understand: '',
      prefer: '',
      trust: '',
      convert: '',
    }),
    [bulkText, setBulkText] = useState('');
  const count = Object.values(manual).flatMap((value) =>
    value.split('\n').filter((line) => line.trim()),
  ).length;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      let accounts: OnboardingInput[];
      if (bulk)
        accounts = parseAccountImport(bulkText, {
          country,
          language,
          timezone,
        });
      else
        accounts = [
          {
            name,
            website,
            country: country.toUpperCase(),
            language,
            timezone,
            description,
            manualPrompts: JOURNEY_STAGES.flatMap((stage) =>
              manual[stage]
                .split('\n')
                .map((text) => text.trim())
                .filter(Boolean)
                .map((text) => ({ text, stage })),
            ),
          },
        ];
      const result = await idempotentPost<{
        items: { project: Project }[];
        limitReached: boolean;
      }>('/onboarding/accounts', { accounts });
      if (result.limitReached) {
        if (bulk)
          setBulkText(
            JSON.stringify(accounts.slice(result.items.length), null, 2),
          );
        setError(
          new Error(
            `${result.items.length} accounts accepted. The remaining accounts are kept here. Your administrator must increase the account limit to continue.`,
          ),
        );
        setRevision((value) => value + 1);
        onChanged();
        return;
      }
      notify(
        `${result.items.length} account${result.items.length === 1 ? '' : 's'} queued. Citevia will create the brandbook, complete the 50 prompts, start a scan and schedule weekly scans.`,
      );
      setRevision((value) => value + 1);
      onChanged();
      setShowForm(false);
      setSearch('');
      setCursors([undefined]);
      setName('');
      setWebsite('');
      setDescription('');
      setBulkText('');
      setManual({ understand: '', prefer: '', trust: '', convert: '' });
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setError(undefined);
    try {
      await idempotentPost(`/projects/${id}/onboarding/retry`);
      setRevision((value) => value + 1);
      notify('Account setup queued for retry. Saved work will be reused.');
    } catch (error) {
      setError(error as Error);
    }
  }
  return (
    <>
      <div className="accounts-intro">
        <div>
          <h2>Your accounts</h2>
          <p>
            One setup for each brand. Citevia researches the company, builds its
            brandbook, prepares 50 prompts and starts tracking.
          </p>
        </div>
        {canCreate && (
          <button
            className="button button-primary"
            onClick={() => setShowForm((value) => !value)}
          >
            <Plus size={14} />
            {showForm ? 'Close form' : 'New account'}
          </button>
        )}
      </div>
      <ErrorNotice error={error || loadError} />
      {canCreate && showForm && (
        <section className="card onboarding-form">
          <div className="card-header">
            <div>
              <h2 className="card-title">Set up accounts</h2>
              <p className="card-description">
                Prompts you supply are kept. AI fills the remaining places, up
                to 50.
              </p>
            </div>
            <div className="tab-buttons">
              <button
                className={!bulk ? 'active' : ''}
                onClick={() => setBulk(false)}
              >
                Single account
              </button>
              <button
                className={bulk ? 'active' : ''}
                onClick={() => setBulk(true)}
              >
                Bulk import
              </button>
            </div>
          </div>
          <form
            className="card-content form-stack"
            onSubmit={(event) => void submit(event)}
          >
            <fieldset disabled={busy} className="onboarding-fieldset">
              {!bulk ? (
                <>
                  <div className="field-row">
                    <label className="field">
                      Company / account name
                      <input
                        required
                        value={name}
                        maxLength={100}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Official website
                      <input
                        required
                        type="url"
                        placeholder="https://company.com"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="field">
                    Company context
                    <textarea
                      rows={3}
                      maxLength={10000}
                      placeholder="Offerings, audience, positioning, important constraints. Citevia also researches the official website."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="field">
                  Paste CSV or JSON
                  <textarea
                    rows={10}
                    required
                    className="code-input"
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder={
                      'name,website,description\nCompany name,https://company.com,Company context'
                    }
                  />
                  <small>
                    1–25 accounts per batch. CSV columns: name, website,
                    description, country, language, timezone, understand,
                    prefer, trust, convert. Use newlines or | between prompts in
                    a section. JSON can include manualPrompts: [
                    {'{"text":"A buyer question?","stage":"understand"}'}].
                    Missing options use the defaults below.
                  </small>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={() =>
                        downloadCsv(
                          'citevia-accounts-template.csv',
                          [
                            'name',
                            'website',
                            'description',
                            'country',
                            'language',
                            'timezone',
                            'understand',
                            'prefer',
                            'trust',
                            'convert',
                          ],
                          [],
                        )
                      }
                    >
                      Download CSV template
                    </button>
                    <input
                      aria-label="Upload accounts CSV or JSON"
                      type="file"
                      accept=".csv,.json,text/csv,application/json"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 150000) {
                          setError(
                            new Error(
                              'Use a file smaller than 150 KB, with at most 25 accounts.',
                            ),
                          );
                          return;
                        }
                        try {
                          setBulkText(await file.text());
                        } catch {
                          setError(new Error('The file could not be read.'));
                        }
                      }}
                    />
                  </div>
                </label>
              )}
              <div className="field-row">
                <label className="field">
                  Market
                  <input
                    required
                    value={country}
                    minLength={2}
                    maxLength={2}
                    onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  />
                </label>
                <label className="field">
                  Language
                  <input
                    required
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                Timezone
                <input
                  required
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
                <small>
                  Weekly scans run Monday at 06:00 in this timezone.
                </small>
              </label>
              {!bulk && (
                <>
                  <div className="manual-prompts-heading">
                    <h3>
                      Existing prompts <span>{count}/50</span>
                    </h3>
                    <p>
                      Optional. One prompt per line in its section. Leave empty
                      to generate all 50.
                    </p>
                  </div>
                  <div className="journey-grid">
                    {JOURNEY_STAGES.map((stage) => (
                      <label className="field" key={stage}>
                        <span className="journey-label">{stage}</span>
                        <textarea
                          rows={5}
                          value={manual[stage]}
                          onChange={(e) =>
                            setManual((previous) => ({
                              ...previous,
                              [stage]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}
              <div className="setting-note">
                {providerReady
                  ? 'Submitting starts OpenAI research and generation calls. After validation, the first scan starts and weekly tracking is enabled automatically.'
                  : 'Configure OpenAI in .env and restart the server before creating accounts.'}
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={!providerReady || busy || count > 50}
                >
                  {busy ? (
                    <LoaderCircle className="spinner" size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  Create {bulk ? 'accounts' : 'account'}
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <div className="filter-bar" style={{ paddingLeft: 0 }}>
        <label className="field" style={{ width: 320, maxWidth: '100%' }}>
          Find an account
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or domain"
          />
        </label>
        <span className="scan-options">
          {filtered.length} of {data?.total || 0} accounts
        </span>
      </div>
      {loading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <section className="card">
          <Empty
            title={
              canCreate ? 'Create your first account' : 'No accounts assigned'
            }
            description={
              canCreate
                ? 'Add a website and company name. The system prepares the brandbook, prompts and scanning schedule.'
                : 'A system administrator can assign the accounts you should see.'
            }
          >
            {canCreate && (
              <button
                className="button button-primary"
                onClick={() => setShowForm(true)}
              >
                New account
              </button>
            )}
          </Empty>
        </section>
      ) : (
        <div className="account-grid">
          {filtered.map((account) => {
            const job = account.onboardingSummary;
            return (
              <section className="card account-card" key={account.id}>
                <div className="account-card-heading">
                  <span className="account-icon">
                    <Building2 size={22} />
                  </span>
                  <div>
                    <h3>{account.name}</h3>
                    <p>{account.brand.domains[0]}</p>
                  </div>
                </div>
                <div className="account-metadata">
                  <span>
                    {account.country} · {account.language}
                  </span>
                  <span>
                    {account.activePromptCount ??
                      account.prompts.filter((p) => p.active).length}
                    /50 active prompts
                  </span>
                </div>
                {job ? (
                  <div className="onboarding-progress">
                    <div>
                      <Badge
                        value={
                          job.status === 'failed'
                            ? 'failed'
                            : job.status === 'completed'
                              ? 'completed'
                              : 'running'
                        }
                        label={
                          job.status === 'completed'
                            ? 'Ready'
                            : job.status === 'failed'
                              ? 'Setup needs attention'
                              : `Creating ${job.step === 'research' ? 'company research' : job.step === 'brandbook' ? 'brandbook' : job.step === 'prompts' ? 'prompts' : 'schedule & first scan'}`
                        }
                      />
                    </div>
                    <div className="workflow-steps">
                      {['research', 'brandbook', 'prompts', 'activate'].map(
                        (step, index) => (
                          <span
                            className={
                              job.status === 'completed' ||
                              [
                                'research',
                                'brandbook',
                                'prompts',
                                'activate',
                              ].indexOf(job.step) > index
                                ? 'done'
                                : ''
                            }
                            key={step}
                          >
                            {step === 'activate' ? 'Start tracking' : step}
                          </span>
                        ),
                      )}
                    </div>
                    {job.error && (
                      <p className="account-error">{job.error.message}</p>
                    )}
                  </div>
                ) : (
                  <p className="card-description">
                    {account.enabled
                      ? 'Weekly tracking enabled'
                      : 'Weekly tracking paused'}
                  </p>
                )}
                <div className="account-actions">
                  {job?.status === 'failed' && account.role === 'owner' && (
                    <button
                      className="button button-outline"
                      onClick={() => void retry(account.id)}
                    >
                      <RefreshCw size={12} />
                      Retry setup
                    </button>
                  )}
                  <button
                    className="button button-outline"
                    onClick={() => onOpen(account.id)}
                  >
                    {job?.status === 'completed' ? (
                      <CheckCircle2 size={12} />
                    ) : null}
                    Open account
                    <ArrowRight size={12} />
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      {data && data.total > 25 && (
        <div className="pagination">
          <span>
            Page {cursors.length} · {data.total} accounts
          </span>
          <div className="page-buttons">
            <button
              disabled={cursors.length === 1}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Previous
            </button>
            <button
              disabled={!data.nextCursor}
              onClick={() =>
                setCursors((previous) => [...previous, data.nextCursor!])
              }
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
