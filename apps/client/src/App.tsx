import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  Clock3,
  Cloud,
  Globe2,
  Info,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  MessageSquareText,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Dashboard,
  Page,
  Project,
  ScanRun,
  OnboardingJob,
} from '@citevia/core';
import { downloadCsv, idempotentPost, query, useApi } from './api';
import {
  authConfigured,
  initializeAuth,
  localAuth,
  signIn,
  signOut,
} from './auth';
import { Empty, ErrorNotice, formatDate, Logo, Spinner } from './components';
import { DashboardView } from './DashboardView';
import MentionsView from './MentionsView';
import SourcesView from './SourcesView';
import SettingsView from './SettingsView';
import PromptsView from './PromptsView';
import ResponseDrawer from './ResponseDrawer';
import AccountsView from './AccountsView';
import BrandbookView from './BrandbookView';
import './onboarding.css';

type View =
  | 'dashboard'
  | 'mentions'
  | 'sources'
  | 'settings'
  | 'accounts'
  | 'brandbook'
  | 'prompts';
const views = {
  prompts: {
    title: 'Prompts',
    description:
      'Manage your questions and track their weekly visibility, sentiment and rank.',
    icon: ListChecks,
  },
  accounts: {
    title: 'Accounts',
    description:
      'Create brands, prepare their prompts, and follow their setup.',
    icon: ShieldCheck,
  },
  brandbook: {
    title: 'Brandbook',
    description:
      'Your company identity, audience, voice and research evidence.',
    icon: Info,
  },
  dashboard: {
    title: 'Dashboard',
    description: 'Your brand in AI answers. The full picture, at a glance.',
    icon: LayoutDashboard,
  },
  mentions: {
    title: 'Mentions',
    description:
      'Every prompt. Every answer. See exactly how your brand shows up.',
    icon: MessageSquareText,
  },
  sources: {
    title: 'Sources',
    description: 'Explore the websites and pages behind ChatGPT’s answers.',
    icon: Globe2,
  },
  settings: {
    title: 'Project settings',
    description: 'Your brand and your weekly scanning schedule.',
    icon: Settings2,
  },
};
function readView(): View {
  const hash = window.location.hash.slice(1);
  return hash in views ? (hash as View) : 'dashboard';
}
function storedProject() {
  try {
    return localStorage.getItem('citevia.project') || '';
  } catch {
    return '';
  }
}

export default function App() {
  const [auth, setAuth] = useState<boolean>(),
    [authError, setAuthError] = useState<Error>();
  useEffect(() => {
    void initializeAuth()
      .then(setAuth)
      .catch((error) => {
        setAuthError(error);
        setAuth(false);
      });
  }, []);
  if (auth === undefined)
    return (
      <div className="login-page">
        <Spinner label="Opening Citevia…" />
      </div>
    );
  if (!auth) return <Login error={authError} />;
  return <Workspace />;
}

function Login({ error }: { error?: Error }) {
  const [localError, setLocalError] = useState<Error>(),
    [busy, setBusy] = useState(false);
  async function login() {
    setBusy(true);
    try {
      await signIn();
    } catch (error) {
      setLocalError(error as Error);
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <Logo />
        <div className="eyebrow">Know where your brand stands</div>
        <h1>
          Your visibility in AI.
          <br />
          Clearer every week.
        </h1>
        <p>
          Track how ChatGPT mentions your brand, understand the sentiment, and
          discover the sources shaping the conversation.
        </p>
        <ErrorNotice error={error || localError} />
        {authConfigured ? (
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void login()}
          >
            {busy ? (
              <LoaderCircle className="spinner" size={15} />
            ) : (
              <LogIn size={15} />
            )}
            {busy ? 'Connecting…' : 'Sign in to your workspace'}
            <ArrowRight size={14} />
          </button>
        ) : (
          <div className="setting-note">
            <Info size={16} />
            <span>
              Sign-in is not configured yet. Your administrator needs to connect
              the Cognito user pool and API URL for this deployment.
            </span>
          </div>
        )}
        <div className="login-footnote">
          <ShieldCheck size={12} /> Secure workspace access · Your account must
          be assigned to a project.
        </div>
      </div>
    </div>
  );
}

function Workspace() {
  const [view, setView] = useState<View>(readView),
    [mobileOpen, setMobileOpen] = useState(false);
  const [projectId, setProjectId] = useState(storedProject),
    [runId, setRunId] = useState('');
  const [revision, setRevision] = useState(0),
    [projectsRevision, setProjectsRevision] = useState(0);
  const [selectedResponse, setSelectedResponse] = useState<string>(),
    [toast, setToast] = useState('');
  const [starting, setStarting] = useState(false),
    [pendingRunId, setPendingRunId] = useState<string>(),
    [actionError, setActionError] = useState<Error>();
  const projects = useApi<{ items: Project[]; mode: 'live' }>(
    '/projects',
    projectsRevision,
  );
  const selectedProject = useApi<Project>(
    projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : null,
    projectsRevision,
  );
  const currentProject =
    projects.data?.items.find((project) => project.id === projectId) ||
    selectedProject.data ||
    projects.data?.items[0];
  const path = currentProject
    ? `/projects/${encodeURIComponent(currentProject.id)}`
    : null;
  const dashboard = useApi<Dashboard>(
    path ? `${path}/dashboard${query({ runId })}` : null,
    revision,
  );
  const runs = useApi<Page<ScanRun>>(path ? `${path}/runs` : null, revision);
  const setup = useApi<{ job: OnboardingJob | null }>(
    path ? `${path}/onboarding` : null,
    revision,
  );
  const settingUp = Boolean(
    setup.data?.job && ['queued', 'running'].includes(setup.data.job.status),
  );
  const project = dashboard.data?.project || currentProject;
  const run = dashboard.data?.run;
  const activeRun = runs.data?.items.find(
    (item) => item.status === 'running' || item.status === 'queued',
  );
  const waitingForFirstRun = Boolean(
    setup.data?.job?.firstRunId &&
      Date.now() - Date.parse(setup.data.job.updatedAt) < 86400000 &&
      !runs.data?.items.some((run) => run.id === setup.data?.job?.firstRunId),
  );
  const hasActiveRun = Boolean(
    activeRun || pendingRunId || settingUp || waitingForFirstRun,
  );
  const runtime = useApi<{ providerConfigured: boolean }>('/runtime', revision);
  const providerReady = runtime.data?.providerConfigured === true;
  const activePrompts =
    project?.prompts.filter((prompt) => prompt.active).length || 0;
  const owner = project?.role === 'owner';

  useEffect(() => {
    const handle = () => {
      setView(readView());
      setMobileOpen(false);
    };
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [hasActiveRun]);
  useEffect(() => {
    if (
      pendingRunId &&
      runs.data?.items.some((item) => item.id === pendingRunId)
    ) {
      setRunId(pendingRunId);
      setPendingRunId(undefined);
    }
  }, [pendingRunId, runs.data]);
  useEffect(() => {
    document.title = `${views[view].title} · Citevia`;
  }, [view]);
  function navigate(next: View) {
    window.location.hash = next;
    setView(next);
    setMobileOpen(false);
  }
  function changeProject(id: string) {
    setProjectId(id);
    setRunId('');
    setPendingRunId(undefined);
    setSelectedResponse(undefined);
    setActionError(undefined);
    try {
      localStorage.setItem('citevia.project', id);
    } catch {
      /* storage unavailable */
    }
  }
  function refresh() {
    setRevision((value) => value + 1);
  }
  function settingsSaved() {
    refresh();
    setProjectsRevision((value) => value + 1);
  }
  async function startScan() {
    if (!path || starting) return;
    setStarting(true);
    setActionError(undefined);
    try {
      const result = await idempotentPost<{ runId: string }>(`${path}/runs`);
      setPendingRunId(result.runId);
      refresh();
      setToast('Scan queued. Answers will appear as collection progresses.');
    } catch (error) {
      setActionError(error as Error);
    } finally {
      setStarting(false);
    }
  }
  function exportSummary() {
    if (!dashboard.data || !run) return;
    const { metrics } = dashboard.data;
    downloadCsv(
      `citevia-summary-${run.id}.csv`,
      ['Metric', 'Value', 'Numerator', 'Denominator'],
      [
        [
          'Visibility (%)',
          metrics.visibility.value,
          metrics.visibility.numerator,
          metrics.visibility.denominator,
        ],
        [
          'Average explicit rank',
          metrics.averageRank.value,
          metrics.averageRank.numerator,
          metrics.averageRank.denominator,
        ],
        ['Captured answers', metrics.captured, '', run.totalCount],
        ['Analyzed answers', metrics.analyzed, '', run.totalCount],
        ['Brand mentions', metrics.mentioned, '', metrics.analyzed],
        ['Citation annotations', metrics.citations, '', ''],
        ['Cited domains', metrics.uniqueDomains, '', ''],
        ['Cited URLs', metrics.uniqueUrls, '', ''],
        ...Object.entries(metrics.sentiment).map(([name, count]) => [
          `Sentiment: ${name}`,
          count,
          '',
          name === 'not_applicable' ? metrics.analyzed : metrics.mentioned,
        ]),
      ],
    );
    setToast('Scan summary exported.');
  }
  return (
    <div className="app">
      <button
        className={`sidebar-shade ${mobileOpen ? 'show' : ''}`}
        aria-label="Close navigation"
        onClick={() => setMobileOpen(false)}
      />
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <Logo />
        <div className="workspace-select">
          <span className="workspace-avatar">
            {project?.brand.name.slice(0, 1).toUpperCase() || 'C'}
          </span>
          <div>
            <div className="workspace-label">Your workspace</div>
            <select
              aria-label="Select project"
              value={currentProject?.id || ''}
              onChange={(event) => changeProject(event.target.value)}
            >
              {currentProject &&
              !projects.data?.items.some(
                (item) => item.id === currentProject.id,
              ) ? (
                <option value={currentProject.id}>{currentProject.name}</option>
              ) : null}
              {projects.data?.items.length ? (
                projects.data.items.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))
              ) : (
                <option value="">No project assigned</option>
              )}
            </select>
          </div>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation" className="nav-list">
          {(
            [
              'accounts',
              'dashboard',
              'prompts',
              'mentions',
              'sources',
              'brandbook',
            ] as View[]
          ).map((key) => {
            const Icon = views[key].icon;
            return (
              <button
                key={key}
                className={`nav-item ${view === key ? 'active' : ''}`}
                aria-current={view === key ? 'page' : undefined}
                onClick={() => navigate(key)}
              >
                <Icon />
                {views[key].title}
              </button>
            );
          })}
        </nav>
        <div className="nav-rule" />
        <nav aria-label="Project configuration">
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            <Settings2 />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="plan-card">
            <div className="plan-title">
              <Sparkles size={13} />
              Weekly essentials
            </div>
            <p className="plan-caption">
              A little focus.
              <br />A clearer AI presence.
            </p>
            <div className="meter">
              <span style={{ width: `${(activePrompts / 50) * 100}%` }} />
            </div>
            <div className="plan-meta">
              <span>{activePrompts} active prompts</span>
              <span>50 included</span>
            </div>
          </div>
          <div className="profile">
            <span className="avatar">
              {project?.brand.name.slice(0, 2).toUpperCase() || 'CV'}
            </span>
            <div>
              <div className="profile-name">Your workspace</div>
              <div className="profile-sub">
                {owner
                  ? 'Project owner'
                  : project
                    ? 'View access'
                    : localAuth
                      ? 'Local operator'
                      : 'Signed in'}
              </div>
            </div>
            <button
              aria-label="Sign out"
              title={localAuth ? 'Reload local session' : 'Sign out'}
              onClick={signOut}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setMobileOpen((value) => !value)}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={11} />
            <strong>{views[view].title}</strong>
          </div>
          <div className="topbar-right">
            <span className="platform-pill">
              <Sparkles size={12} />
              ChatGPT
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              onClick={refresh}
              aria-label="Refresh results"
              title="Refresh results"
            >
              <RefreshCw
                size={15}
                className={dashboard.loading && dashboard.data ? 'spinner' : ''}
              />
            </button>
            <span className="avatar">
              {project?.brand.name.slice(0, 2).toUpperCase() || 'CV'}
            </span>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">AI VISIBILITY INTELLIGENCE</div>
              <h1>{views[view].title}</h1>
              <p>{views[view].description}</p>
            </div>
            <div className="heading-actions">
              {!['settings', 'accounts', 'brandbook'].includes(view) && (
                <label className="select-button">
                  <CalendarDays size={13} />
                  <span className="visually-hidden">Select scan</span>
                  <select
                    value={runId}
                    onChange={(event) => {
                      setRunId(event.target.value);
                      setSelectedResponse(undefined);
                    }}
                  >
                    <option value="">Latest scan</option>
                    {runs.data?.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {formatDate(item.createdAt, true)} · {item.status}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {view === 'dashboard' && (
                <button
                  className="button button-outline"
                  onClick={exportSummary}
                  disabled={!run}
                >
                  <ArrowDownToLine size={13} />
                  Export
                </button>
              )}
              {owner && view !== 'accounts' && (
                <button
                  className="button button-primary"
                  onClick={() => void startScan()}
                  disabled={
                    !providerReady || starting || hasActiveRun || !activePrompts
                  }
                  title={
                    !providerReady
                      ? 'Configure OpenAI to enable scans'
                      : !activePrompts
                        ? 'Add an active prompt in Prompts first'
                        : hasActiveRun
                          ? 'A scan is already in progress'
                          : 'Start a scan of your active prompts'
                  }
                >
                  {starting || hasActiveRun ? (
                    <LoaderCircle size={13} className="spinner" />
                  ) : (
                    <Play size={12} />
                  )}
                  {starting
                    ? 'Starting…'
                    : hasActiveRun
                      ? 'Scanning…'
                      : 'Run scan'}
                </button>
              )}
            </div>
          </div>
          {runtime.data?.providerConfigured === false && (
            <div className="provider-banner" role="status">
              <Info size={16} />
              <span>
                <strong>OpenAI is not configured.</strong> Add OPENAI_API_KEY or
                OPENAI_SECRET_ARN to .env and restart the local server. Account
                generation and scans are disabled until configured.
              </span>
            </div>
          )}
          <ErrorNotice error={runtime.error} retry={refresh} />
          <ErrorNotice
            error={projects.error}
            retry={() => setProjectsRevision((value) => value + 1)}
          />
          <ErrorNotice error={dashboard.error} retry={refresh} />
          <ErrorNotice error={actionError} />
          {view === 'accounts' ? (
            <AccountsView
              providerReady={providerReady}
              onOpen={(id) => {
                changeProject(id);
                setProjectsRevision((value) => value + 1);
                navigate('dashboard');
              }}
              onChanged={() => setProjectsRevision((value) => value + 1)}
              notify={setToast}
            />
          ) : projects.loading && !projects.data ? (
            <Spinner />
          ) : !currentProject && !projects.error ? (
            <div className="card">
              <Empty
                title="Your workspace is almost ready"
                description="Create an account to build its brandbook, generate prompts and start weekly tracking."
              >
                <button
                  className="button button-primary"
                  onClick={() => setProjectsRevision((value) => value + 1)}
                >
                  <RefreshCw size={13} />
                  Refresh access
                </button>
                <button
                  className="button button-primary"
                  onClick={() => navigate('accounts')}
                >
                  Create account
                </button>
              </Empty>
            </div>
          ) : (
            path &&
            project && (
              <>
                {!['settings', 'brandbook'].includes(view) && run && (
                  <div className="status-strip">
                    <span
                      className={`status-dot ${['running', 'queued'].includes(run.status) ? 'running' : ['partial', 'failed'].includes(run.status) ? 'warning' : ''}`}
                    />
                    <span>
                      <strong>
                        {run.status === 'completed'
                          ? 'Scan complete'
                          : run.status === 'partial'
                            ? 'Scan completed with issues'
                            : run.status === 'failed'
                              ? 'Scan failed'
                              : 'Scan in progress'}
                      </strong>{' '}
                      · {run.succeededCount}/{run.totalCount} prompts analyzed ·{' '}
                      {formatDate(run.createdAt)}
                    </span>
                    <span className="status-right">
                      <Clock3 size={11} />
                      {project.enabled
                        ? `Next scan ${formatDate(dashboard.data?.nextScanAt)}`
                        : 'Schedule paused'}
                    </span>
                  </div>
                )}
                {dashboard.loading &&
                !dashboard.data &&
                !['settings', 'brandbook'].includes(view) ? (
                  <Spinner label="Bringing your results together…" />
                ) : view === 'settings' ? (
                  <SettingsView
                    key={project.id}
                    path={path}
                    revision={revision}
                    nextScanAt={dashboard.data?.nextScanAt}
                    onSaved={settingsSaved}
                    notify={setToast}
                  />
                ) : view === 'prompts' ? (
                  <PromptsView
                    key={project.id}
                    path={path}
                    revision={revision}
                    run={run}
                    onSaved={settingsSaved}
                    notify={setToast}
                    onResponse={setSelectedResponse}
                  />
                ) : view === 'brandbook' ? (
                  <BrandbookView
                    path={path}
                    revision={revision}
                    onSaved={settingsSaved}
                    notify={setToast}
                  />
                ) : (
                  dashboard.data &&
                  (view === 'dashboard' ? (
                    <DashboardView
                      dashboard={dashboard.data}
                      path={path}
                      revision={revision}
                      onResponse={setSelectedResponse}
                      onMentions={() => navigate('mentions')}
                      onSources={() => navigate('sources')}
                    />
                  ) : view === 'mentions' ? (
                    <MentionsView
                      key={`${project.id}-${run?.id || 'empty'}`}
                      path={path}
                      runId={run?.id}
                      revision={revision}
                      onResponse={setSelectedResponse}
                      notify={setToast}
                    />
                  ) : (
                    <SourcesView
                      key={`${project.id}-${run?.id || 'empty'}`}
                      path={path}
                      dashboard={dashboard.data}
                      revision={revision}
                      onResponse={setSelectedResponse}
                    />
                  ))
                )}
                <footer className="page-footer">
                  <span>
                    <Cloud size={11} />
                    Powered by OpenAI API answers with web search
                  </span>
                  <span>
                    <ShieldCheck size={11} />
                    Weekly snapshots · Original answers preserved
                  </span>
                </footer>
              </>
            )
          )}
        </main>
      </div>
      {selectedResponse && path && (
        <ResponseDrawer
          path={path}
          id={selectedResponse}
          onClose={() => setSelectedResponse(undefined)}
          revision={revision}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
