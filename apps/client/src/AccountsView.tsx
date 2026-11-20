import { reportExcerpt } from './report-excerpt';
import { Skeleton } from './Loading';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  LoaderCircle,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type {
  AccountOnboardingInput,
  OnboardingJob,
  Project,
} from '@citevia/core';
import {
  JOURNEY_STAGES,
  journeyAllocation, brandedAllocation, promptLimitFor,
  journeyGoal,
} from '@citevia/core';
import {
  downloadCsv,
  idempotentPost,
  useApi,
  query,
  onboardAccounts,
  request,
} from './api';
import { previewProgress } from './prospect-preview';
import { parseAccountImport } from './account-import';
import LanguageSelect from './LanguageSelect';
import { Badge, Empty, ErrorNotice } from './components';
type Account = Project & {
  activePromptCount?: number;
  onboardingSummary?: Pick<
    OnboardingJob,
    'status' | 'step' | 'error' | 'firstRunId'
  >;
};
export default function AccountsView({
  onOpen,
  onboardingReady,
  canCreate,
  onChanged,
  notify,
}: {
  canCreate: boolean;
  onboardingReady: { standard: boolean; prospect: boolean };
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
    [accountType, setAccountType] = useState<'standard' | 'prospect'>('standard'),
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
    (p) => p.accountType === 'prospect' ? previewProgress(p).pending :
      p.onboardingSummary && ['queued', 'running'].includes(p.onboardingSummary.status),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [pending]);
  const [name, setName] = useState(''),
    [website, setWebsite] = useState(''),
    [promptFocus, setPromptFocus] = useState(''),
    [region, setRegion] = useState('US'),
    [language, setLanguage] = useState('en'),
    [bulkText, setBulkText] = useState('');
  const [correctedNames, setCorrectedNames] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState<string>();
  const prospect = !bulk && accountType === 'prospect';
  const allocation = journeyAllocation([], accountType);
  const brandedCount = Object.values(brandedAllocation(allocation, 0, accountType)).reduce((sum, count) => sum + count, 0);
  let providerReady = onboardingReady[prospect ? 'prospect' : 'standard'];
  if (bulk && !onboardingReady.standard && onboardingReady.prospect) {
    try { providerReady = parseAccountImport(bulkText).every(item => item.accountType === 'prospect'); }
    catch { /* Keep the standard requirement until a valid batch is entered. */ }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const accounts: AccountOnboardingInput[] = bulk
        ? parseAccountImport(bulkText)
        : [{ name, website, region, language, ...(prospect ? { accountType: 'prospect' as const } : {}), ...(promptFocus.trim() ? { promptFocus: promptFocus.trim() } : {}) }];
      const result = await onboardAccounts(accounts);
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
        bulk ? `${result.items.length} accounts queued for onboarding.`
          : prospect ? 'Prospect preview queued. Citevia will scan 10 prompts once on ChatGPT.'
          : 'Account queued. Citevia will create the brandbook, generate 50 prompts and start twice-weekly tracking.',
      );
      setRevision((value) => value + 1);
      onChanged();
      setShowForm(false);
      setAccountType('standard');
      setSearch('');
      setCursors([undefined]);
      setName('');
      setWebsite('');
      setPromptFocus('');
      setBulkText('');
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setRetrying(id);
    setError(undefined);
    try {
      const correctedName = correctedNames[id]?.trim();
      if (correctedName) {
        const settings = await request<Project>(`/projects/${id}/settings`);
        if (settings.brand.name !== correctedName) {
          await request(`/projects/${id}/settings`, {
            method: 'PATCH',
            body: JSON.stringify({ version: settings.version, name: correctedName,
              brand: { ...settings.brand, name: correctedName } }),
          });
        }
      }
      await idempotentPost(`/projects/${id}/onboarding/retry`);
      setRevision((value) => value + 1);
      onChanged();
      notify(correctedName ? 'Account setup queued with the corrected brand name.' : 'Account setup queued for retry. Valid saved work will be reused.');
    } catch (error) {
      setError(error as Error);
      setRevision((value) => value + 1);
    } finally {
      setRetrying(undefined);
    }
  }
  async function stop(id: string) {
    setError(undefined);
    try {
      await idempotentPost(`/projects/${id}/onboarding/stop`);
      setRevision((value) => value + 1);
      onChanged();
      notify('Setup stopped. Saved progress is preserved.');
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
            brandbook and measures its visibility in AI answers.
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
                Enter the brand name, region, language and URL. Citevia
                researches the website and generates the brandbook and prompts.
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
                  <label className="field">
                    Account type
                    <select value={accountType} onChange={event => setAccountType(event.target.value === 'prospect' ? 'prospect' : 'standard')}>
                      <option value="standard">Standard account</option>
                      <option value="prospect">Prospect preview</option>
                    </select>
                  </label>
                  <div className="field-row">
                    <label className="field">
                      Brand name
                      <input
                        required
                        value={name}
                        maxLength={100}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <small>Use the business name shown on its official website, in its original language. The prompt language can be different.</small>
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
                    placeholder={'name,region,language,website'}
                  />
                  <small>
                    1–25 accounts per batch. Each CSV row or JSON object needs
                    name, region, language and website. Add promptFocus to
                    prioritize a product or service. Use accountType “prospect” for a one-time ChatGPT preview. Empty or omitted accountType uses standard onboarding.
                  </small>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={() =>
                        downloadCsv(
                          'citevia-accounts-template.csv',
                          ['name', 'region', 'language', 'website', 'promptFocus', 'accountType'],
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
              {!bulk && (
                <div className="field-row">
                  <label className="field">
                    Region
                    <input
                      required
                      value={region}
                      minLength={2}
                      maxLength={2}
                      pattern="[A-Za-z]{2}"
                      placeholder="US"
                      onChange={(e) => setRegion(e.target.value.toUpperCase())}
                    />
                    <small>
                      Two-letter country/region code, such as US or GB.
                    </small>
                  </label>
                  <label className="field">
                    Language
                    <LanguageSelect value={language} onChange={setLanguage} />
                    <small>
                      Choose the language for research and generated prompts.
                    </small>
                  </label>
                </div>
              )}
              {!bulk && (
                <label className="field">
                  Prompt focus (optional)
                  <input value={promptFocus} maxLength={300} onChange={(e) => setPromptFocus(e.target.value)} placeholder="A specific product or service" />
                  <small>Leave blank to cover the business’s main offerings.</small>
                </label>
              )}
              {!bulk && <div className="generated-portfolio">
                <h3>{promptLimitFor(accountType) - brandedCount} unbranded prompts and {brandedCount} branded prompts</h3>
                <div className="journey-grid">
                  {JOURNEY_STAGES.map((stage) => (
                    <div className="journey-tactic" key={stage}>
                      <strong className="journey-label">
                        {stage}
                        <span>{allocation[stage]} prompts</span>
                      </strong>
                      <p>
                        {journeyGoal(
                          stage,
                          !bulk && name.trim() ? name.trim() : 'the brand',
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="card-description">
                  {prospect ? 'One ChatGPT scan. The results stay available for your presentation.' : 'Two scans each week are assigned automatically, 3½ days apart. View your times in Settings after setup.'}
                </p>
              </div>}
              <div className="setting-note">
                {providerReady
                  ? bulk ? 'Each account uses its selected onboarding type. Standard accounts start twice-weekly tracking.' : prospect ? 'Submitting starts brand research, prompt generation and a single ChatGPT scan.' : 'Submitting starts OpenAI research and generation calls. After validation, the first scans start on all three providers and twice-weekly tracking is enabled automatically.'
                  : 'The credentials required for this onboarding type must be configured before setup can start.'}
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={!providerReady || busy}
                >
                  {busy ? (
                    <LoaderCircle className="spinner" size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  Create {bulk ? 'accounts' : prospect ? 'preview' : 'account'}
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
          {data ? `${filtered.length} of ${data.total}` : '—'} accounts
        </span>
      </div>
      {loading && !data ? (
        <Skeleton variant="cards" rows={3} label="Loading your accounts…" />
      ) : !data && loadError ? null : !data?.items.length ? (
        <section className="card">
          <Empty
            title={
              debounced
                ? 'No matching accounts'
                : canCreate ? 'Create your first account' : 'No accounts assigned'
            }
            description={
              debounced
                ? 'Try another company name or domain, or clear your search to see all accounts.'
                : canCreate
                ? 'Add a website and company name. The system prepares the brandbook, prompts and scanning schedule.'
                : 'A system administrator can assign the accounts you should see.'
            }
          >
            {debounced ? (
              <button className="button button-outline" onClick={() => setSearch('')}>
                Clear search
              </button>
            ) : canCreate && (
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
            const preview = account.accountType === 'prospect' ? previewProgress(account) : undefined;
            return (
              <section className="card account-card" key={account.id}>
                <div className="account-card-heading">
                  <span className="account-icon">
                    <Building2 size={22} />
                  </span>
                  <div>
                    <h3>{account.name}</h3>
                    <p>{account.brand.domains[0]}{preview && ' · Prospect preview'}</p>
                  </div>
                </div>
                <div className="account-metadata">
                  <span>
                    {account.country} · {account.language}
                  </span>
                  <span>
                    {account.activePromptCount ??
                      account.prompts.filter((p) => p.active).length}
                    /{promptLimitFor(account.accountType)} active prompts
                  </span>
                </div>
                {job ? (
                  <div className="onboarding-progress">
                    <div>
                      <Badge
                        value={
                          preview ? preview.tone : ['failed', 'stopped'].includes(job.status)
                            ? 'failed'
                            : job.status === 'completed'
                              ? 'completed'
                              : 'running'
                        }
                        label={
                          preview ? preview.label : job.status === 'completed'
                            ? 'Ready'
                            : ['failed', 'stopped'].includes(job.status)
                              ? 'Setup stopped'
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
                            {step === 'activate' ? preview ? 'Start scan' : 'Start tracking' : step}
                          </span>
                        ),
                      )}
                    </div>
                    {job.error && (
                      <p className="account-error">{reportExcerpt(job.error.message)}</p>
                    )}
                    {job.status === 'failed' && account.role === 'owner' &&
                      !account.onboardingAppliedJobId && job.error &&
                      ['onboarding_official_research_missing', 'brandbook_evidence_invalid', 'onboarding_account_changed'].includes(job.error.code) && (
                        <label className="field">
                          Official brand name
                          <input dir="auto" maxLength={100}
                            value={correctedNames[account.id] ?? account.brand.name}
                            disabled={retrying === account.id}
                            onChange={(event) => setCorrectedNames(current => ({ ...current, [account.id]: event.target.value }))} />
                          <small>Copy the name from the official website. Retry saves a corrected name and researches it again. Keep English brands in English.</small>
                        </label>
                      )}
                    {['failed', 'stopped'].includes(job.status) && (
                      <p className="card-description">
                        No more generation calls or scans will start
                        automatically. Retry setup explicitly to continue from
                        saved progress.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="card-description">
                    {preview ? preview.label : account.enabled
                      ? 'Scheduled tracking enabled'
                      : 'Scheduled tracking paused'}
                  </p>
                )}
                <div className="account-actions">
                  {job &&
                    ['queued', 'running'].includes(job.status) &&
                    account.role === 'owner' && (
                      <button
                        className="button button-outline"
                        onClick={() => void stop(account.id)}
                      >
                        Stop setup
                      </button>
                    )}
                  {job &&
                    ['failed', 'stopped'].includes(job.status) &&
                    account.role === 'owner' && (
                      <button
                        className="button button-outline"
                        disabled={retrying === account.id || correctedNames[account.id]?.trim() === ''}
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
                    {(preview ? preview.tone === 'completed' : job?.status === 'completed') ? (
                      <CheckCircle2 size={12} />
                    ) : null}
                    {preview && account.previewScan ? 'View preview' : 'Open account'}
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
