import { Skeleton } from './Loading';
import { useState, type FormEvent } from 'react';
import {
  CalendarClock,
  Info,
  LoaderCircle,
  RefreshCw,
  Save,
} from 'lucide-react';
import type { Page, Project, ScanRun } from '@citevia/core';
import {
  projectProviders,
  PROVIDER_LABELS,
  SCAN_PROVIDERS,
  snapshotProvider,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PERPLEXITY_PRESET,
  projectScanRunsPerWeek,
} from '@citevia/core';
import { idempotentPost, request, useApi } from './api';
import { Badge, Empty, ErrorNotice, formatDate } from './components';
import SocialAutomationSettings from './SocialAutomationSettings';
import GeoBacklinkSettings from './GeoBacklinkSettings';
import './project-settings.css';

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
  systemAdmin = false,
}: {
  path: string;
  nextScanAt?: string | null;
  systemAdmin?: boolean;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const {
    data: project,
    error,
    loading,
  } = useApi<Project>(`${path}/settings`);
  const runs = useApi<Page<ScanRun>>(`${path}/runs`);
  const [section, setSection] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('section') === 'publishing' ? 'publishing' : 'general');
  return (
    <>
      <ErrorNotice error={error} retry={onSaved} />
      {loading && !project ? (
        <Skeleton variant="form" label="Loading project settings…" />
      ) : (
        project && (
          <>
            <div className="project-settings-page">
            <nav className="settings-sections" aria-label="Settings sections">
              {[
                ['general', 'General'], ['publishing', 'Publishing'],
                ...(systemAdmin ? [['geo', 'GEO backlinks']] : []),
              ].map(([key, label]) => (
                <button type="button" key={key} aria-current={section === key ? 'page' : undefined}
                  className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}</button>
              ))}
            </nav>
            {section === 'general' && <div className="settings-grid">
              <ProjectForm
                key={`${project.id}-${project.version}`}
                project={project}
                path={path}
                onSaved={onSaved}
                notify={notify}
              />
              <aside className="settings-sidebar"><section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Your scan schedule</h2>
                    <p className="card-description">
                      {project.scanSchedule
                        ? `${projectScanRunsPerWeek(project)} ${projectScanRunsPerWeek(project) === 1 ? 'snapshot' : 'snapshots'} each week, evenly spaced.`
                        : 'Automatic snapshots on your saved schedule.'}
                    </p>
                  </div>
                </div>
                <div className="card-content">
                  <ScanningToggle
                    key={`${project.id}-${project.version}`}
                    project={project}
                    path={path}
                    onSaved={onSaved}
                    notify={notify}
                  />
                  <WeeklyScanFrequency
                    key={`frequency-${project.id}-${project.version}`}
                    project={project}
                    path={path}
                    onSaved={onSaved}
                    notify={notify}
                  />
                  <div className="setting-note">
                    <CalendarClock size={17} />
                    <span>
                      <strong>{scheduleLabel(project)}</strong>
                      <br />
                      {project.demo
                        ? `${projectScanRunsPerWeek(project)} scans per week.`
                        : project.enabled
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
                </div>
              </section>
              <section className="card">
                <div className="card-header"><div><h2 className="card-title">Recent scans</h2>
                  <p className="card-description">Your latest snapshots and their status.</p></div></div>
                <div className="card-content">
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
                        owner={project.role === 'owner' && !project.demo && project.enabled}
                        onSaved={onSaved}
                        notify={notify}
                      />
                    ))}
                    {runs.data && !runs.data.items.length && (
                      <p className="card-description">No scans yet.</p>
                    )}
                  </div>
                </div>
              </section></aside>
            </div>}
            {section === 'geo' && systemAdmin && <GeoBacklinkSettings key={`${project.id}-${project.version}`} project={project} path={path} onSaved={onSaved} notify={notify} />}
            {section === 'publishing' && <SocialAutomationSettings key={project.id} project={project} path={path} onSaved={onSaved} notify={notify} />}
            {section === 'general' &&             <section className="card">
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
            </section>}
            </div>
          </>
        )
      )}
    </>
  );
}

function WeeklyScanFrequency({ project, path, onSaved, notify }: {
  project: Project;
  path: string;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [savedRuns, setSavedRuns] = useState(projectScanRunsPerWeek(project));
  const [runsPerWeek, setRunsPerWeek] = useState(String(savedRuns));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const owner = project.role === 'owner' && !project.demo;
  const count = Number(runsPerWeek);
  const valid = runsPerWeek.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 7;
  const unchanged = !!project.scanSchedule && count === savedRuns;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!owner || saving || unchanged) return;
    if (!valid) {
      setError(new Error('Enter a whole number from 1 to 7.'));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await request<Project>(`${path}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ version: project.version, scanRunsPerWeek: count }),
      });
      const savedCount = projectScanRunsPerWeek(saved);
      setSavedRuns(savedCount);
      setRunsPerWeek(String(savedCount));
      notify(`Scan schedule saved: ${savedCount} ${savedCount === 1 ? 'run' : 'runs'} per week.`);
      onSaved();
    } catch (error) {
      setError(error as Error);
      // A schedule-sync failure can still have persisted the requested frequency.
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Weekly scan frequency" onSubmit={(event) => void submit(event)} style={{ marginBottom: 18 }}>
      <ErrorNotice error={error} />
      <label className="field">
        Runs per week
        <input
          type="number"
          min={1}
          max={7}
          step={1}
          required
          value={runsPerWeek}
          onChange={(event) => setRunsPerWeek(event.target.value)}
          disabled={!owner || saving}
          aria-describedby="weekly-scan-frequency-help"
        />
        <small id="weekly-scan-frequency-help">
          Choose a whole number from 1 to 7. Each run checks all active prompts on your selected providers.
          {!project.scanSchedule && ' Save to apply this frequency in place of your current schedule.'}
          {!project.enabled && ' Scanning stays paused until you enable it.'}
        </small>
      </label>
      {owner && (
        <button className="button button-outline" type="submit" disabled={saving || !valid || unchanged} style={{ marginTop: 10 }}>
          {saving ? <LoaderCircle size={13} className="spinner" /> : <Save size={13} />}
          {saving ? 'Saving…' : 'Save scan frequency'}
        </button>
      )}
    </form>
  );
}

function ScanningToggle({ project, path, onSaved, notify }: {
  project: Project;
  path: string;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [enabled, setEnabled] = useState(project.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const owner = project.role === 'owner' && !project.demo;
  async function toggle() {
    if (!owner || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await request<Project>(`${path}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ version: project.version, enabled: !enabled }),
      });
      setEnabled(saved.enabled);
      notify(saved.enabled ? 'Scanning enabled.' : 'Scanning paused. Your saved data is preserved.');
      onSaved();
    } catch (error) {
      setError(error as Error);
      // A schedule-sync failure can still have saved the new scanning state.
      onSaved();
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="scanning-control">
      <div className="scanning-control-heading">
        <div>
          <strong id="scanning-toggle-label">Scanning enabled</strong>
          <p className="card-description" role="status">{saving ? 'Saving…' : enabled ? 'On' : 'Paused'}</p>
        </div>
        <button
          type="button"
          className="scanning-switch"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="scanning-toggle-label"
          aria-describedby="scanning-toggle-description"
          disabled={!owner || saving}
          onClick={() => void toggle()}
        >
          <span />
        </button>
      </div>
      <p id="scanning-toggle-description" className="card-description">
        Pause scheduled scans, manual scans and retries. Your account and all saved results stay available.
      </p>
      <ErrorNotice error={error} />
    </div>
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
    [timezone, setTimezone] = useState(project.timezone);
  const [scanProviders, setScanProviders] = useState(projectProviders(project));
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<Error>();
  const owner = project.role === 'owner' && !project.demo;
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
          country: country.toUpperCase(),
          language,
          timezone,
          scanProviders,
        }),
      });
      notify('Project settings saved.');
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
            Manage your project identity and the regions you track.
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
            <div className="settings-group-heading"><h3>Brand identity</h3><p>Names and websites used to recognize your brand.</p></div>
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
            <div className="settings-group-heading"><h3>Region & language</h3><p>Set your search location and how scan times are displayed.</p></div>
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
                {project.scanSchedule ? 'Used to display scan times. Changing the timezone keeps your scheduled start times unchanged.' : 'A valid IANA timezone for your saved schedule.'}
              </small>
            </label>
            <div className="settings-group-heading"><h3>AI coverage</h3><p>Choose where to measure your brand visibility.</p></div>
            <div className="settings-provider-list">
              <p className="card-description">
                Each selected provider checks the same active prompts during a scan.
              </p>
              {SCAN_PROVIDERS.map((provider) => {
                const config = scanProviders.find(
                  (item) => item.provider === provider,
                );
                return (
                  <div className="settings-provider" key={provider}>
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
                  </div>
                );
              })}
              {!scanProviders.length && (
                <p role="alert">Select at least one provider.</p>
              )}
            </div>
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
