import {
  AuthProvider,
  Descope,
  useDescope,
  useSession,
} from '@descope/react-sdk';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  Clock3,
  Cloud,
  Globe2,
  Info,
  LayoutDashboard,
  ListChecks,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  MessageSquareText,
  Play,
  Plug,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Dashboard,
  Page,
  Project,
  ScanRun,
  OnboardingJob,
  User,
  ScanProvider,
} from '@citevia/core';
import {
  projectProviders,
  PROVIDER_LABELS,
  SCAN_PROVIDERS,
  snapshotProvider,
} from '@citevia/core';
import { idempotentPost, query, useApi } from './api';
import ApiSessionProvider from './ApiSessionProvider';
import { invalidateApiQueries } from './query-cache';
import {
  authConfigured,
  descopeProjectId,
  descopeBaseUrl,
  descopeFlowId,
} from './auth';
import UsersView from './UsersView';
import { Empty, ErrorNotice, formatDate, Logo } from './components';
import { Skeleton } from './Loading';
import { DashboardView } from './DashboardView';
import MentionsView from './MentionsView';
import TrackingView from './TrackingView';
import TrafficView from './TrafficView';
import WebsiteHealthView from './WebsiteHealthView';
import SourcesView from './SourcesView';
import SettingsView from './SettingsView';
import PromptsView from './PromptsView';
import ResponseDrawer from './ResponseDrawer';
import AccountsView from './AccountsView';
import BrandbookView from './BrandbookView';
import FilterDropdown from './FilterDropdown';
import AccountSwitcher from './AccountSwitcher';
import McpView from './McpView';
import McpConsent from './McpConsent';
import AgentsView from './AgentsView';
import IntegrationsView from './IntegrationsView';
import DemoContentView, { readDemoContentPath } from './DemoContentView';
import './onboarding.css';

type View =
  | 'dashboard'
  | 'mentions'
  | 'tracking'
  | 'traffic'
  | 'website-health'
  | 'sources'
  | 'settings'
  | 'accounts'
  | 'brandbook'
  | 'prompts'
  | 'agents'
  | 'integrations'
  | 'mcp'
  | 'users';
const views = {
  'website-health': { title: 'Website Health', description: 'Find what to improve on mobile and desktop.', icon: Activity },
  agents: { title: 'Agents', description: 'Create content with your AI agents.', icon: Bot },
  integrations: { title: 'Integrations', description: 'Connect your analytics, social agents and workflow tools.', icon: Plug },
  mcp: {
    title: 'MCP connections',
    description: 'Connect your AI assistant to Citevia with your account permissions.',
    icon: Plug,
  },
  traffic: { title: 'AI Traffic', description: 'See the visits AI sends to your website.', icon: ChartNoAxesCombined },
  tracking: { title: 'Tracking', description: 'Track your content in AI answers.', icon: Link2 },
  users: {
    title: 'Users',
    description: 'Manage users and assign access to customer accounts.',
    icon: Users,
  },
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
    description: 'Explore the websites and pages behind your AI answers.',
    icon: Globe2,
  },
  settings: {
    title: 'Project settings',
    description: 'Your brand and your weekly scanning schedule.',
    icon: Settings2,
  },
};
function readView(): View {
  const hash = window.location.hash.slice(1).split('?')[0];
  return hash in views ? (hash as View) : 'dashboard';
}
function readIntegrationHighlight() {
  return new URLSearchParams(window.location.hash.split('?')[1] || '').get('highlight') || undefined;
}
function storedProject() {
  try {
    return localStorage.getItem('citevia.project') || '';
  } catch {
    return '';
  }
}

export default function App() {
  if (!authConfigured) return <Login />;
  return (
    <AuthProvider
      projectId={descopeProjectId}
      baseUrl={descopeBaseUrl}
      autoRefresh
      persistTokens
    >
      <SessionGate />
    </AuthProvider>
  );
}
function SessionGate() {
  const { isAuthenticated, isSessionLoading, claims } = useSession();
  const authorizationRequest = new URLSearchParams(window.location.search).get('mcp_authorize');
  const demoContent = readDemoContentPath(window.location.pathname);
  if (isSessionLoading)
    return (
      <div className="workspace-loading">
        <Logo />
        <Skeleton variant="workspace" label="Opening your workspace…" />
      </div>
    );
  return isAuthenticated ? (
    <ApiSessionProvider key={String(claims?.sub || 'session')} sessionId={String(claims?.sub || 'session')}>
      {authorizationRequest ? (
        <McpConsent key={authorizationRequest} requestId={authorizationRequest} />
      ) : demoContent ? (
        <DemoContentView {...demoContent} />
      ) : (
        <Workspace />
      )}
    </ApiSessionProvider>
  ) : (
    <Login />
  );
}
function Login() {
  const [error, setError] = useState<Error>();
  return (
    <div className="login-page login-layout">
      <section className="login-story" aria-label="Welcome to Citevia">
        <Logo />
        <div className="login-story-copy">
          <div className="eyebrow">AI SEARCH INTELLIGENCE</div>
          <h2>Clarity in every<br /><em>AI answer.</em></h2>
          <p>Understand where your brand stands, what shapes the answers, and where to go next.</p>
          <div className="login-features">
            <span><ChartNoAxesCombined size={18} />See your visibility evolve</span>
            <span><MessageSquareText size={18} />Explore the answers that matter</span>
            <span><Link2 size={18} />Find the sources behind the story</span>
          </div>
        </div>
        <a className="login-website" href="https://citevia.io" target="_blank" rel="noopener noreferrer">Discover Citevia <ArrowRight size={15} /></a>
      </section>
      <div className="login-card">
        <div className="eyebrow">YOUR WORKSPACE, CONNECTED</div>
        <h1>Sign in to Citevia</h1>
        <p>
          Welcome back. Sign in to explore your brand’s presence in AI search.
        </p>
        <ErrorNotice error={error} />
        {authConfigured ? (
          <Descope
            flowId={descopeFlowId}
            onError={() =>
              setError(
                new Error('Sign-in could not be completed. Please try again.'),
              )
            }
          />
        ) : (
          <div className="setting-note">
            <Info size={16} />
            <span>
              Sign-in is not configured yet. Your administrator needs to finish
              setting up this workspace before you can continue.
            </span>
          </div>
        )}
        <div className="login-footnote">
          <ShieldCheck size={12} />
          Account access is controlled by the system administrator.
        </div>
      </div>
    </div>
  );
}

function Workspace() {
  const { logout } = useDescope();
  const [view, setView] = useState<View>(readView),
    [mobileOpen, setMobileOpen] = useState(false);
  const [integrationHighlight, setIntegrationHighlight] = useState(readIntegrationHighlight);
  const navigationRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [projectId, setProjectId] = useState(storedProject),
    [runId, setRunId] = useState('');
  const [provider, setProvider] = useState<ScanProvider>('openai');
  const [selectedResponse, setSelectedResponse] = useState<string>(),
    [toast, setToast] = useState('');
  const [starting, setStarting] = useState(false),
    [pendingRunId, setPendingRunId] = useState<string>(),
    [actionError, setActionError] = useState<Error>();
  const me = useApi<User>('/me');
  useEffect(() => {
    if (!mobileOpen) return;
    if (me.error) { setMobileOpen(false); return; }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const navigation = navigationRef.current;
    const focusable = () => [...(navigation?.querySelectorAll<HTMLElement>('button:not(:disabled),select,a[href]') || [])];
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const onResize = () => { if (window.innerWidth > 700) setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      menuRef.current?.focus();
    };
  }, [mobileOpen, me.error]);
  const systemAdmin = me.data?.isSystemAdmin === true;
  const projects = useApi<{ items: Project[]; mode: 'live' }>(
    '/projects',
  );
  const selectedProject = useApi<Project>(
    projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : null,
  );
  const currentProject =
    projects.data?.items.find((project) => project.id === projectId) ||
    selectedProject.data ||
    projects.data?.items[0];
  const path = currentProject
    ? `/projects/${encodeURIComponent(currentProject.id)}`
    : null;
  const dashboard = useApi<Dashboard>(
    path && !['agents', 'integrations', 'mcp', 'website-health'].includes(view) ? `${path}/dashboard${query({ runId, provider })}` : null,
  );
  const runs = useApi<Page<ScanRun>>(path ? `${path}/runs` : null);
  const setup = useApi<{ job: OnboardingJob | null }>(
    path ? `${path}/onboarding` : null,
  );
  const settingUp = Boolean(
    setup.data?.job && ['queued', 'running'].includes(setup.data.job.status),
  );
  const project = view === 'dashboard'
    ? currentProject
    : dashboard.data?.project || currentProject;
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
  const runtime = useApi<{
    providerConfigured: boolean;
    providers: Record<ScanProvider, boolean>;
  }>('/runtime');
  const enabledProviders = project
    ? projectProviders(project)
    : SCAN_PROVIDERS.map((provider) => ({ provider, model: '' }));
  const providerReady =
    runtime.data?.providerConfigured === true &&
    runtime.data.providers.openai &&
    enabledProviders.every(
      (config) => runtime.data!.providers[config.provider],
    );
  const onboardingReady =
    runtime.data?.providerConfigured === true &&
    SCAN_PROVIDERS.every((provider) => runtime.data!.providers[provider]);
  const missingProviders = runtime.data
    ? SCAN_PROVIDERS.filter((provider) => !runtime.data!.providers[provider])
    : [];
  const activePrompts =
    project?.activePromptCount ?? project?.prompts.filter((prompt) => prompt.active).length ?? 0;
  const owner = project?.role === 'owner' && !project.demo;

  useEffect(() => {
    const handle = () => {
      setView(readView());
      setIntegrationHighlight(readIntegrationHighlight());
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
    const timer = setInterval(() => { if (path) void invalidateApiQueries(path); }, 5000);
    return () => clearInterval(timer);
  }, [hasActiveRun, path]);
  useEffect(() => {
    if (
      pendingRunId &&
      runs.data?.items.some((item) => item.id === pendingRunId)
    ) {
      const primary = runs.data.items.find((item) => item.id === pendingRunId)!;
      const enabled =
        primary.snapshot.scanProviders?.some(
          (config) => config.provider === provider,
        ) ?? snapshotProvider(primary.snapshot) === provider;
      const selected = runs.data.items.find(
        (item) =>
          (item.groupId ?? item.id) === pendingRunId &&
          snapshotProvider(item.snapshot) === provider,
      );
      if (enabled && !selected) return;
      setRunId(selected?.id ?? primary.id);
      setProvider(snapshotProvider((selected ?? primary).snapshot));
      setPendingRunId(undefined);
    }
  }, [pendingRunId, runs.data, provider]);
  useEffect(() => {
    document.title = `${views[view].title} · Citevia`;
    window.scrollTo(0, 0);
  }, [view]);
  function navigate(next: View, highlight?: string) {
    window.location.hash = next + (next === 'integrations' && highlight ? `?${new URLSearchParams({ highlight })}` : '');
    setIntegrationHighlight(highlight);
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
    void invalidateApiQueries();
  }
  function settingsSaved() {
    refresh();
  }
  async function startScan() {
    if (!path || starting || project?.demo) return;
    setStarting(true);
    setActionError(undefined);
    try {
      const result = await idempotentPost<{
        runId: string;
        runs: { provider: ScanProvider; runId: string }[];
      }>(`${path}/runs`);
      setPendingRunId(result.runId);
      refresh();
      setToast('Scan queued. Answers will appear as collection progresses.');
    } catch (error) {
      setActionError(error as Error);
    } finally {
      setStarting(false);
    }
  }
  useEffect(() => {
    const update = () => {
      void invalidateApiQueries();
    };
    window.addEventListener('focus', update);
    const timer = setInterval(update, 60000);
    return () => {
      window.removeEventListener('focus', update);
      clearInterval(timer);
    };
  }, []);
  const scanAction = owner ? (
    <button
      className="button button-primary"
      onClick={() => void startScan()}
      disabled={
        !providerReady || starting || hasActiveRun || !activePrompts
      }
      title={
        !providerReady
          ? 'Configure API credentials for all enabled providers to enable scans'
          : !activePrompts
            ? 'Add an active prompt in Prompts first'
            : hasActiveRun
              ? 'A scan is already in progress'
              : 'Scan active prompts on every enabled provider'
      }
    >
      {starting || hasActiveRun ? (
        <LoaderCircle size={13} className="spinner" />
      ) : (
        <Play size={12} />
      )}
      {starting ? 'Starting…' : hasActiveRun ? 'Scanning…' : 'Run scan'}
    </button>
  ) : null;
  if (me.loading && !me.data)
    return (
      <div className="workspace-loading">
        <Logo />
        <Skeleton variant="workspace" label="Loading your account access…" />
      </div>
    );
  if (me.error)
    return (
      <div className="login-page">
        <div className="login-card">
          <Logo />
          <h1>Workspace access unavailable</h1>
          <ErrorNotice error={me.error} retry={refresh} />
          <button
            className="button button-outline"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  return (
    <div className="app">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
      <button
        className={`sidebar-shade ${mobileOpen ? 'show' : ''}`}
        aria-label="Close navigation"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setMobileOpen(false)}
      />
      <aside ref={navigationRef} id="workspace-navigation" className={`sidebar ${mobileOpen ? 'open' : ''}`} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined} aria-label="Workspace navigation">
        <button className="icon-button sidebar-mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={18} /></button>
        <Logo />
        <AccountSwitcher
          project={currentProject}
          projects={projects.data?.items || []}
          onChange={changeProject}
        />
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation" className="nav-list">
          {(
            [
              'accounts',
              'dashboard',
              'prompts',
              'mentions',
              'tracking',
              'sources',
              'traffic',
              'website-health',
              'agents',
              'brandbook',
              ...(systemAdmin ? ['users' as const] : []),
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
            className={`nav-item ${view === 'integrations' ? 'active' : ''}`}
            aria-current={view === 'integrations' ? 'page' : undefined}
            onClick={() => navigate('integrations')}
          >
            <Plug />
            Integrations
          </button>
          <button
            className={`nav-item ${view === 'mcp' ? 'active' : ''}`}
            aria-current={view === 'mcp' ? 'page' : undefined}
            onClick={() => navigate('mcp')}
          >
            <Plug />
            MCP connections
          </button>
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
              Your weekly pulse
            </div>
            <p className="plan-caption">
              A clearer view of your brand<br />across AI search.
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
              <div className="profile-name">
                {me.data?.name || me.data?.email || 'Your workspace'}
              </div>
              <div className="profile-sub">
                {systemAdmin
                  ? 'System admin'
                  : owner
                    ? 'Account owner'
                    : 'Viewer'}
              </div>
            </div>
            <button
              aria-label="Sign out"
              title="Sign out"
              onClick={() =>
                void logout()
                  .then(() => {
                    localStorage.removeItem('citevia.project');
                  })
                  .catch(() =>
                    setActionError(
                      new Error('Sign-out failed. Please try again.'),
                    ),
                  )
              }
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main" inert={mobileOpen}>
        <header className="topbar">
          <button
            ref={menuRef}
            className="icon-button mobile-menu"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileOpen}
            aria-controls="workspace-navigation"
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
            {view === 'sources' && (
              <FilterDropdown
                label="AI provider"
                value={provider}
                active={false}
                onChange={(value) => {
                  setProvider(value as ScanProvider);
                  setRunId('');
                  setSelectedResponse(undefined);
                  setPendingRunId(undefined);
                }}
                options={SCAN_PROVIDERS.map((value) => ({
                  value,
                  label: PROVIDER_LABELS[value],
                  icon: (
                    <img
                      src={`/providers/${value}.svg`}
                      alt=""
                      width={20}
                      height={20}
                      aria-hidden="true"
                    />
                  ),
                }))}
              />
            )}
            <span className="topbar-divider" />
            <button
              className="icon-button"
              onClick={refresh}
              aria-label="Refresh results"
              title="Refresh results"
            >
              <RefreshCw
                size={15}
                className={view !== 'dashboard' && dashboard.loading && dashboard.data ? 'spinner' : ''}
              />
            </button>
            <span className="avatar">
              {project?.brand.name.slice(0, 2).toUpperCase() || 'CV'}
            </span>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={`content ${['dashboard', 'prompts', 'mentions', 'tracking', 'traffic', 'website-health', 'agents', 'integrations'].includes(view) ? 'prompts-content' : ''}`}
        >
          {!['dashboard', 'prompts', 'mentions', 'tracking', 'traffic', 'website-health', 'agents', 'integrations'].includes(view) && (
            <div className="page-heading">
              <div>
                <div className="eyebrow">AI VISIBILITY INTELLIGENCE</div>
                <h1>{views[view].title}</h1>
                <p>{views[view].description}</p>
              </div>
              <div className="heading-actions">
                {view === 'sources' && (
                  <FilterDropdown
                    label="Select scan"
                    value={runId}
                    active={false}
                    icon={<CalendarDays size={16} />}
                    onChange={(value) => {
                      setRunId(value);
                      setSelectedResponse(undefined);
                    }}
                    options={[
                      { value: '', label: 'Latest scan' },
                      ...(runs.data?.items ?? [])
                        .filter(
                          (item) =>
                            snapshotProvider(item.snapshot) === provider,
                        )
                        .map((item) => ({
                          value: item.id,
                          label: `${formatDate(item.createdAt, true)} · ${item.status}${item.reanalysisOf ? ' · Reanalysis' : ''}`,
                        })),
                    ]}
                  />
                )}
                {!['accounts', 'users', 'mcp'].includes(view) && scanAction}
              </div>
            </div>
          )}
          {!project?.demo && !['mcp', 'agents', 'integrations', 'website-health'].includes(view) && missingProviders.length > 0 && (
            <div className="provider-banner" role="status">
              <Info size={16} />
              <span>
                <strong>
                  Provider setup needed:{' '}
                  {missingProviders
                    .map((value) => PROVIDER_LABELS[value])
                    .join(', ')}
                  .
                </strong>{' '}
                Ask your administrator to connect these providers before starting a scan.
              </span>
            </div>
          )}
          {!currentProject && !systemAdmin && !projects.loading && (
            <div className="setting-note">
              <Info size={14} />
              <span>
                Signed in as {me.data?.email}. Ask a system administrator to
                assign your accounts. Your database user ID:{' '}
                <code>{me.data?.id}</code>
              </span>
            </div>
          )}
          {!['mcp', 'agents', 'integrations', 'website-health'].includes(view) && <ErrorNotice error={runtime.error} retry={refresh} />}
          <ErrorNotice
            error={projects.error}
            retry={() => void invalidateApiQueries('/projects')}
          />
          {!['dashboard', 'mcp', 'agents', 'integrations', 'website-health'].includes(view) && <ErrorNotice error={dashboard.error} retry={refresh} />}
          <ErrorNotice error={actionError} />
          {view === 'mcp' ? (
            !systemAdmin && projects.loading && !projects.data ? (
              <Skeleton variant="cards" label="Loading your accounts…" />
            ) : (
              <McpView systemAdmin={systemAdmin} project={currentProject} />
            )
          ) : view === 'integrations' ? (
            <IntegrationsView key={systemAdmin ? 'system' : currentProject?.id || 'unassigned'} systemAdmin={systemAdmin} project={currentProject} highlight={integrationHighlight} onMcp={() => navigate('mcp')} onTraffic={() => navigate('traffic')} />
          ) : view === 'users' ? (
            systemAdmin ? (
              <UsersView
                self={me.data!}
                notify={setToast}
                onChanged={settingsSaved}
              />
            ) : (
              <Empty
                title="Administrator access required"
                description="Only system administrators can manage users."
              />
            )
          ) : view === 'accounts' ? (
            <AccountsView
              canCreate={systemAdmin}
              providerReady={onboardingReady}
              onOpen={(id) => {
                changeProject(id);
                navigate('dashboard');
              }}
              onChanged={() => void invalidateApiQueries('/projects')}
              notify={setToast}
            />
          ) : projects.loading && !projects.data ? (
            <Skeleton variant={view === 'dashboard' ? 'dashboard' : ['settings', 'brandbook'].includes(view) ? 'form' : 'table'} />
          ) : !currentProject && !projects.error ? (
            <div className="card">
              <Empty
                title={
                  systemAdmin
                    ? 'Create your first account'
                    : 'No accounts assigned'
                }
                description={
                  systemAdmin
                    ? 'Create an account to build its brandbook, generate prompts and start weekly tracking.'
                    : 'Ask a system administrator to assign your customer accounts. Your account list is private to your login.'
                }
              >
                <button
                  className="button button-primary"
                  onClick={() => void invalidateApiQueries('/projects')}
                >
                  <RefreshCw size={13} />
                  Refresh access
                </button>
                {systemAdmin ? (
                  <button
                    className="button button-primary"
                    onClick={() => navigate('accounts')}
                  >
                    Create account
                  </button>
                ) : (
                  <p className="scan-options">
                    Your database user ID: {me.data?.id}
                  </p>
                )}
              </Empty>
            </div>
          ) : (
            path &&
            project && (
              <>
                {!['dashboard', 'settings', 'brandbook', 'prompts', 'mentions', 'tracking', 'traffic', 'website-health', 'agents', 'integrations'].includes(view) &&
                  run && (
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
                        · {run.succeededCount}/{run.totalCount} prompts analyzed
                        · {formatDate(run.createdAt)}
                      </span>
                      <span className="status-right">
                        <Clock3 size={11} />
                        {project.demo
                          ? '2 scans per week'
                          : project.enabled
                          ? `Next scan ${formatDate(dashboard.data?.nextScanAt)}`
                          : 'Schedule paused'}
                      </span>
                    </div>
                  )}
                {dashboard.loading &&
                !dashboard.data &&
                !['dashboard', 'settings', 'brandbook', 'prompts', 'mentions', 'tracking', 'traffic', 'website-health', 'agents', 'integrations'].includes(view) ? (
                  <Skeleton variant="cards" label="Bringing your results together…" />
                ) : view === 'website-health' ? (
                  <WebsiteHealthView key={project.id} project={project} path={path} notify={setToast} />
                ) : view === 'agents' ? (
                  <AgentsView key={project.id} project={project} onIntegrations={(highlight) => navigate('integrations', highlight)} />
                ) : view === 'settings' ? (
                  <SettingsView
                    key={project.id}
                    path={path}
                    nextScanAt={dashboard.data?.nextScanAt}
                    onSaved={settingsSaved}
                    notify={setToast}
                  />
                ) : view === 'prompts' ? (
                  <PromptsView
                    key={project.id}
                    path={path}
                    demo={project.demo}
                    onSaved={settingsSaved}
                    notify={setToast}
                  />
                ) : view === 'mentions' ? (
                  <MentionsView key={project.id} path={path} project={project} onResponse={setSelectedResponse} />
                ) : view === 'traffic' ? (
                  <TrafficView key={project.id} path={path} project={project} notify={setToast} />
                ) : view === 'tracking' ? (
                  <TrackingView key={project.id} path={path} project={project} onResponse={setSelectedResponse} notify={setToast} />
                ) : view === 'brandbook' ? (
                  <BrandbookView
                    path={path}
                    readOnly={Boolean(project.demo)}
                    onSaved={settingsSaved}
                    notify={setToast}
                  />
                ) : view === 'dashboard' ? (
                  <DashboardView
                    key={project.id}
                    project={project}
                    path={path}
                    actions={scanAction}
                  />
                ) : (
                  dashboard.data && (
                    <SourcesView
                      key={`${project.id}-${run?.id || 'empty'}`}
                      path={path}
                      dashboard={dashboard.data}
                      onResponse={setSelectedResponse}
                    />
                  )
                )}
                {!['agents', 'website-health'].includes(view) && <footer className="page-footer">
                  <span>
                    <Cloud size={11} />
                    {project.demo ? 'ChatGPT, Perplexity and Gemini results' : 'Native ChatGPT, Perplexity and Gemini API answers'}
                  </span>
                  <span>
                    <ShieldCheck size={11} />
                    {project.demo ? 'Twice-weekly scans · Answer history' : 'Weekly snapshots · Original answers preserved'}
                  </span>
                </footer>}
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
