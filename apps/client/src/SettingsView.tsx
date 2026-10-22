import { Skeleton } from './Loading';
import { useState, type FormEvent } from 'react';
import {
  CalendarClock,
  Info,
  LoaderCircle,
  RefreshCw,
  Save,
} from 'lucide-react';
import type { Brand, Page, Project, ScanRun } from '@citevia/core';
import {
  projectProviders,
  PROVIDER_LABELS,
  SCAN_PROVIDERS,
  snapshotProvider,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PERPLEXITY_PRESET,
} from '@citevia/core';
import { idempotentPost, request, useApi } from './api';
import { Badge, Empty, ErrorNotice, formatDate } from './components';
import CompetitorSettings from './CompetitorSettings';

function scheduleLabel(project: Project) {
  if (!project.scanSchedule) return `${project.scheduleExpression} (${project.timezone})`;
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return project.scanSchedule.slotsUtcMinutes.map(slot => `${days[Math.floor(slot / 1440)]} ${String(Math.floor(slot / 60) % 24).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')} UTC`).join(' · ');
}

export default function SettingsView({
  path,
  onSaved,
  notify,
  nextScanAt,
}: {
  path: string;
  nextScanAt?: string | null;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const {
    data: project,
    error,
    loading,
  } = useApi<Project>(`${path}/settings`);
  const runs = useApi<Page<ScanRun>>(`${path}/runs`);
  return (
    <>
      <ErrorNotice error={error} retry={onSaved} />
      {loading && !project ? (
        <Skeleton variant="form" label="Loading project settings…" />
      ) : (
        project && (
          <>
            <div className="settings-grid">
              <ProjectForm
                key={`${project.id}-${project.version}`}
                project={project}
                path={path}
                onSaved={onSaved}
                notify={notify}
              />
              <aside className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Your scan schedule</h2>
                    <p className="card-description">
                      {project.scanSchedule ? 'Two snapshots each week, 3½ days apart.' : 'Automatic snapshots on your saved schedule.'}
                    </p>
                  </div>
                </div>
                <div className="card-content">
                  <div className="setting-note">
                    <CalendarClock size={17} />
                    <span>
                      <strong>{scheduleLabel(project)}</strong>
                      <br />
                      {project.enabled
                        ? (project.nextScanAt || nextScanAt)
                          ? `Next scan: ${new Date((project.nextScanAt || nextScanAt)!).toLocaleString('en', { timeZone: project.timezone, dateStyle: 'medium', timeStyle: 'short' })} (${project.timezone})`
                          : 'Next scan time is unavailable.'
                        : 'Scan schedule is paused.'}
                    </span>
                  </div>
                  <div className="scan-options">
                    Up to 50 active prompts per project. Changing a prompt or
                    your brand settings creates a new comparison baseline.
                  </div>
                  {project.scheduleStatus && (
                    <div style={{ marginTop: 14 }}>
                      <Badge
                        value={
                          project.scheduleStatus === 'synced'
                            ? 'completed'
                            : project.scheduleStatus === 'error'
                              ? 'failed'
                              : 'queued'
                        }
                        label={`Schedule ${project.scheduleStatus}`}
                      />
                    </div>
                  )}
                  <h3
                    className="drawer-section-title"
                    style={{ marginBottom: 13 }}
                  >
                    Recent scans
                  </h3>
                  <ErrorNotice error={runs.error} />
                  <div className="run-history">
                    {runs.loading && !runs.data && (
                      <Skeleton
                        variant="table"
                        rows={3}
                        label="Loading recent scans…"
                      />
                    )}
                    {runs.data?.items.slice(0, 6).map((run) => (
                      <RunHistoryRow
                        key={run.id}
                        run={run}
                        path={path}
                        owner={project.role === 'owner'}
                        onSaved={onSaved}
                        notify={notify}
                      />
                    ))}
                    {runs.data && !runs.data.items.length && (
                      <p className="card-description">No scans yet.</p>
                    )}
                  </div>
                  <h3 className="drawer-section-title">Collection settings</h3>
                  <p className="scan-options">
                    {projectProviders(project).map((config) => (
                      <span key={config.provider}>
                        {PROVIDER_LABELS[config.provider]}: {config.model}
                        <br />
                      </span>
                    ))}
                    <br />
                    Analysis model: {project.extractionModel}
                    <br />
                    Parser: {project.parserVersion}
                    <br />
                    Search is enabled for every provider. Gemini decides when to
                    ground an answer. OpenAI analyzes all captured answers.
                  </p>
                </div>
              </aside>
            </div>
            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Your prompt portfolio</h2>
                  <p className="card-description">
                    Add, edit and archive prompts in the dedicated Prompts
                    screen.
                  </p>
                </div>
                <a className="button button-outline" href="#prompts">
                  Manage prompts
                </a>
              </div>
            </section>
          </>
        )
      )}
    </>
  );
}

function ProjectForm({
  project,
  path,
  onSaved,
  notify,
}: {
  project: Project;
  path: string;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [name, setName] = useState(project.name),
    [brandName, setBrandName] = useState(project.brand.name);
  const [aliases, setAliases] = useState(project.brand.aliases.join(', ')),
    [domains, setDomains] = useState(project.brand.domains.join(', '));
  const [country, setCountry] = useState(project.country),
    [language, setLanguage] = useState(project.language),
    [timezone, setTimezone] = useState(project.timezone),
    [enabled, setEnabled] = useState(project.enabled);
  const [competitors, setCompetitors] = useState<Brand[]>(project.competitors);
  const [competitorsEdited, setCompetitorsEdited] = useState(false);
  const [scanProviders, setScanProviders] = useState(projectProviders(project));
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<Error>();
  const owner = project.role === 'owner';
  const split = (value: string) => [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!owner) return;
    setSaving(true);
    setError(undefined);
    try {
      await request<Project>(`${path}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: project.version,
          name: name.trim(),
          brand: {
            ...project.brand,
            name: brandName.trim(),
            aliases: split(aliases),
            domains: split(domains),
          },
          ...(competitorsEdited
            ? {
                competitors: competitors.map((competitor) => ({
                  ...competitor,
                  name: competitor.name.trim(),
                  aliases: competitor.aliases.flatMap(split),
                  domains: competitor.domains.flatMap(split),
                })),
              }
            : {}),
          country: country.toUpperCase(),
          language,
          timezone,
          enabled,
          scanProviders,
        }),
      });
      notify(
        competitorsEdited && competitors.length
          ? 'Settings saved. Competitors are tracked in the dashboard and future scans.'
          : 'Project settings saved.',
      );
      onSaved();
    } catch (error) {
      setError(error as Error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Brand & workspace</h2>
          <p className="card-description">
            Tell Citevia what to look for in the answers
          </p>
        </div>
      </div>
      <form className="card-content" onSubmit={(event) => void submit(event)}>
        <ErrorNotice error={error} />
        {!owner && (
          <div className="setting-note" style={{ marginBottom: 18 }}>
            <Info size={14} />
            <span>
              You have view access. A project owner can change these settings.
            </span>
          </div>
        )}
        <fieldset
          disabled={!owner || saving}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <div className="form-stack">
            <div className="field-row">
              <label className="field">
                Project name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={100}
                />
              </label>
              <label className="field">
                Brand name
                <input
                  value={brandName}
                  onChange={(event) => setBrandName(event.target.value)}
                  required
                  maxLength={100}
                />
              </label>
            </div>
            <label className="field">
              Brand aliases
              <input
                value={aliases}
                onChange={(event) => setAliases(event.target.value)}
                placeholder="Alternative names, abbreviations"
              />
              <small>
                Separate aliases with commas. Include only names that clearly
                refer to your brand.
              </small>
            </label>
            <label className="field">
              Your domains
              <input
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                placeholder="example.com, example.co.uk"
              />
              <small>
                Separate domains with commas. These identify your owned sources.
              </small>
            </label>
            <div className="field-row">
              <label className="field">
                Country
                <input
                  value={country}
                  onChange={(event) =>
                    setCountry(event.target.value.toUpperCase())
                  }
                  required
                  minLength={2}
                  maxLength={2}
                  placeholder="US"
                />
                <small>Two-letter country code for search location.</small>
              </label>
              <label className="field">
                Language code
                <input
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  required
                  maxLength={20}
                  pattern="[a-z]{2,3}(-[A-Za-z0-9]{2,8})*"
                  placeholder="en"
                />
                <small>Language code such as en, de, or en-GB.</small>
              </label>
            </div>
            <label className="field">
              Timezone
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
                list="timezones"
              />
              <datalist id="timezones">
                {[
                  'UTC',
                  'America/New_York',
                  'America/Los_Angeles',
                  'Europe/London',
                  'Europe/Berlin',
                  'Asia/Nicosia',
                  'Asia/Jerusalem',
                  'Asia/Dubai',
                  'Asia/Singapore',
                  'Australia/Sydney',
                ].map((value) => (
                  <option value={value} key={value} />
                ))}
              </datalist>
              <small>
                {project.scanSchedule ? 'Used to display scan times. Your two fixed UTC start times stay unchanged.' : 'A valid IANA timezone for your saved schedule.'}
              </small>
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Scheduled scanning enabled
            </label>
            <div className="form-stack">
              <strong>Scan providers</strong>
              <p className="card-description">
                The same portfolio of up to 50 prompts runs on each selected
                provider. All three means up to 150 answers per scan. API keys are
                configured on the server.
              </p>
              {SCAN_PROVIDERS.map((provider) => {
                const config = scanProviders.find(
                  (item) => item.provider === provider,
                );
                return (
                  <div key={provider}>
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={!!config}
                        onChange={(event) =>
                          setScanProviders((previous) =>
                            event.target.checked
                              ? [
                                  ...previous,
                                  {
                                    provider,
                                    model:
                                      provider === 'openai'
                                        ? project.generationModel
                                        : provider === 'gemini'
                                          ? DEFAULT_GEMINI_MODEL
                                          : DEFAULT_PERPLEXITY_PRESET,
                                  },
                                ]
                              : previous.filter(
                                  (item) => item.provider !== provider,
                                ),
                          )
                        }
                      />
                      {PROVIDER_LABELS[provider]}
                    </label>
                    {config && (
                      <label className="field">
                        {provider === 'perplexity'
                          ? 'Agent API preset'
                          : 'Answer model'}
                        <input
                          required
                          maxLength={160}
                          value={config.model}
                          onChange={(event) =>
                            setScanProviders((previous) =>
                              previous.map((item) =>
                                item.provider === provider
                                  ? { ...item, model: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                    )}
                  </div>
                );
              })}
              {!scanProviders.length && (
                <p role="alert">Select at least one provider.</p>
              )}
            </div>
            <CompetitorSettings
              project={project}
              path={path}
              value={competitors}
              onChange={(value) => {
                setCompetitors(value);
                setCompetitorsEdited(true);
              }}
            />
            {owner && (
              <div className="form-actions">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={saving || !scanProviders.length}
                >
                  {saving ? (
                    <LoaderCircle size={13} className="spinner" />
                  ) : (
                    <Save size={13} />
                  )}
                  {saving ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function RunHistoryRow({
  run,
  path,
  owner,
  onSaved,
  notify,
}: {
  run: ScanRun;
  path: string;
  owner: boolean;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  async function retry() {
    setBusy(true);
    setError(undefined);
    try {
      await idempotentPost(
        `${path}/runs/${encodeURIComponent(run.id)}/retry-failed`,
      );
      notify('Failed prompts were queued for another attempt.');
      onSaved();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="run-history-row">
        <div>
          <strong>
            {PROVIDER_LABELS[snapshotProvider(run.snapshot)]} ·{' '}
            {formatDate(run.createdAt)}
          </strong>
          <small>
            {run.succeededCount} / {run.totalCount} analyzed
          </small>
        </div>
        <Badge value={run.status} />
        {owner && ['partial', 'failed'].includes(run.status) && (
          <button
            className="icon-button"
            disabled={busy}
            title="Retry failed prompts"
            aria-label={`Retry failed prompts from ${formatDate(run.createdAt)}`}
            onClick={() => void retry()}
          >
            <RefreshCw size={13} className={busy ? 'spinner' : ''} />
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
