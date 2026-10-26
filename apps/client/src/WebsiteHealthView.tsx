import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, ChevronDown, Clipboard, Clock3, ExternalLink, Gauge, Globe2, Info, LoaderCircle, Monitor, Play, RefreshCw, Smartphone, Sparkles } from 'lucide-react';
import type { Project, WebsiteHealthAudit, WebsiteHealthCategory, WebsiteHealthDevice, WebsiteHealthFieldResult, WebsiteHealthIssue, WebsiteHealthMetric, WebsiteHealthPage } from '@citevia/core';
import { idempotentPost, useApi } from './api';
import { invalidateApiQueries } from './query-cache';
import { Empty, ErrorNotice, formatDate, safeUrl } from './components';
import { Skeleton } from './Loading';
import AnswerMarkdown from './AnswerMarkdown';
import './website-health.css';

const categories: { id: WebsiteHealthCategory; label: string }[] = [
  { id: 'performance', label: 'Performance' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'best-practices', label: 'Best practices' },
  { id: 'seo', label: 'SEO' },
];
const deviceLabels = { mobile: 'Mobile', desktop: 'Desktop' };
const active = (audit?: WebsiteHealthAudit) => Boolean(audit && ['queued', 'running'].includes(audit.status));
const scoreRating = (value?: number | null) => value == null ? 'unknown' : value >= 90 ? 'good' : value >= 50 ? 'needs-improvement' : 'poor';
const ratingLabel = (rating: string) => ({ good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor', unknown: 'Not available' }[rating] || 'Not available');
const auditLabel = (status: WebsiteHealthAudit['status']) => ({ queued: 'Queued', running: 'Running', completed: 'Complete', partial: 'Partially complete', failed: 'Failed' }[status]);

export function previousWebsiteHealthAudit(items: WebsiteHealthAudit[], audit: WebsiteHealthAudit, device: WebsiteHealthDevice) {
  return items.filter(item => item.id !== audit.id && item.url === audit.url && Date.parse(item.createdAt) < Date.parse(audit.createdAt) && item.results[device].status === 'completed' && item.results[device].lab)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

function issueSavings(issue: WebsiteHealthIssue) {
  const savings: string[] = [];
  if (issue.savingsMs != null && issue.savingsMs > 0) savings.push(`${(issue.savingsMs / 1000).toLocaleString('en', { maximumFractionDigits: 2 })} s`);
  if (issue.savingsBytes != null && issue.savingsBytes > 0) savings.push(`${(issue.savingsBytes / 1024).toLocaleString('en', { maximumFractionDigits: 0 })} KiB`);
  return savings.join(' · ');
}

export function websiteHealthChecklist(audit: WebsiteHealthAudit, device: WebsiteHealthDevice) {
  const lab = audit.results[device].lab;
  if (!lab) return '';
  return [
    `Website Health — ${deviceLabels[device]}`,
    audit.url,
    `Audited: ${lab.fetchedAt}`,
    '',
    ...categories.map(category => `${category.label}: ${lab.scores[category.id] == null ? 'Not available' : `${lab.scores[category.id]}/100`}`),
    '',
    'Developer checklist',
    ...prioritizedIssues(lab.issues).flatMap((issue, index) => [
      `${index + 1}. [${issue.priority.toUpperCase()}] ${issue.title}`,
      issue.description,
      ...(issueSavings(issue) ? [`Estimated potential savings: ${issueSavings(issue)} (estimates overlap; do not add together).`] : []),
      ...issue.resources.map(resource => `   ${resource}`),
      '',
    ]),
    'Recheck this page on mobile and desktop after applying changes. Lab results can vary between runs.',
  ].join('\n');
}
function prioritizedIssues(issues: WebsiteHealthIssue[]) {
  const order = { high: 0, medium: 1, low: 2 };
  return [...issues].sort((a, b) => order[a.priority] - order[b.priority] || (b.savingsMs || 0) - (a.savingsMs || 0) || (b.savingsBytes || 0) - (a.savingsBytes || 0));
}

function MetricGrid({ metrics }: { metrics: WebsiteHealthMetric[] }) {
  return <div className="health-metric-grid">{metrics.map(metric => <div key={metric.id} className="health-metric">
    <span>{metric.title}</span>
    <strong>{metric.value == null ? '—' : metric.displayValue || '—'}</strong>
    <small className={`health-rating ${metric.value == null ? 'unknown' : metric.rating}`}><i aria-hidden="true" />{metric.value == null ? 'Not available' : ratingLabel(metric.rating)}</small>
  </div>)}</div>;
}

function FieldMetrics({ field, cruxAvailable }: { field?: WebsiteHealthFieldResult; cruxAvailable: boolean }) {
  return <section className="card health-field" aria-labelledby="health-field-title">
    <div className="health-section-heading"><div><span className="health-kicker"><Globe2 size={13} /> REAL VISITORS</span><h2 id="health-field-title">Real-user Core Web Vitals</h2><p>Google Chrome user experiences over a rolling 28-day period.</p></div><span className="health-source">CrUX</span></div>
    {field?.status === 'available' ? <>
      <div className="health-field-scope"><span className="tag">{field.scope === 'origin' ? 'Whole website (origin)' : 'This page (URL)'}</span>{field.collectionPeriod && <span>{formatDate(field.collectionPeriod.start, true)} – {formatDate(field.collectionPeriod.end, true)}</span>}</div>
      {field.url && <p className="health-field-url">{field.url}</p>}
      {field.scope === 'origin' && <p className="health-note">Page-level data was unavailable. These measurements cover visitors across this website.</p>}
      {field.metrics.length ? <MetricGrid metrics={field.metrics} /> : <p className="health-note">No real-user measurements were returned for this device.</p>}
    </> : <div className="health-field-empty"><Info size={20} /><div><strong>{field?.status === 'error' ? 'Real-user data could not be loaded' : field?.status === 'unavailable' ? 'Not enough real-user data' : field?.status === 'not_configured' || !cruxAvailable ? 'Real-user data is not connected yet' : 'Real-user data is being checked'}</strong><p>{field?.message || (field?.status === 'unavailable' ? 'Google needs enough eligible Chrome traffic for this page or website and device. You can still use the lab audit and improvement checklist.' : field?.status === 'error' ? 'You can still use the lab audit. Run another audit to try real-user measurements again.' : field?.status === 'not_configured' || !cruxAvailable ? 'Ask your administrator to enable Google real-user measurements. PageSpeed lab audits are available independently.' : 'Measurements will appear when this device audit finishes.')}</p></div></div>}
  </section>;
}

export default function WebsiteHealthView({ project, path, notify }: { project: Project; path: string; notify: (message: string) => void }) {
  const collectionPath = `${path}/website-health/audits`;
  const latest = useApi<WebsiteHealthPage>(`${collectionPath}?cursor=0&limit=10`);
  const [cursor, setCursor] = useState<string | null>(null);
  const older = useApi<WebsiteHealthPage>(cursor ? `${collectionPath}?cursor=${encodeURIComponent(cursor)}&limit=10` : null);
  const [olderItems, setOlderItems] = useState<WebsiteHealthAudit[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [submittedAudit, setSubmittedAudit] = useState<WebsiteHealthAudit>();
  const [url, setUrl] = useState('');
  const initialUrlSet = useRef(false);
  const [device, setDevice] = useState<WebsiteHealthDevice>('mobile');
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<Error>();
  const [copied, setCopied] = useState(false);
  const [category, setCategory] = useState<WebsiteHealthCategory | 'all'>('all');
  const [checklist, setChecklist] = useState<string>();
  const owner = project.role === 'owner' && !project.demo;
  const listedHistory = [...new Map([...(submittedAudit ? [submittedAudit] : []), ...olderItems, ...(latest.data?.items || [])].map(audit => [audit.id, audit])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const reportId = selectedId || listedHistory[0]?.id;
  const details = useApi<{ audit: WebsiteHealthAudit }>(reportId ? `${collectionPath}/${encodeURIComponent(reportId)}` : null);
  const detailAudit = details.data?.audit;
  const history = listedHistory.map(item => detailAudit && detailAudit.id === item.id ? detailAudit : item);
  const selectedHistory = history.find(audit => audit.id === reportId);
  const audit = detailAudit && detailAudit.id === reportId ? detailAudit : selectedHistory;
  const current = audit?.results[device];
  const lab = current?.lab;
  const previous = audit ? previousWebsiteHealthAudit(history, audit, device) : undefined;
  const isActive = history.some(active) || active(audit);
  const available = latest.data?.auditingAvailable === true;
  const nextCursor = cursor ? older.data?.nextCursor : latest.data?.nextCursor;
  const issues = prioritizedIssues(lab?.issues || []);
  const visibleIssues = issues.filter(issue => category === 'all' || issue.category === category);

  useEffect(() => {
    if (!initialUrlSet.current && latest.data) {
      setUrl(latest.data.defaultUrl || '');
      initialUrlSet.current = true;
    }
  }, [latest.data]);
  useEffect(() => {
    if (older.data) setOlderItems(items => [...new Map([...items, ...older.data!.items].map(audit => [audit.id, audit])).values()]);
  }, [older.data]);
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => void invalidateApiQueries(`${path}/website-health`), 5000);
    return () => clearInterval(timer);
  }, [isActive, path]);
  useEffect(() => { setCopied(false); setChecklist(undefined); }, [reportId, device]);
  useEffect(() => {
    if (submittedAudit && latest.data?.items.some(item => item.id === submittedAudit.id)) setSubmittedAudit(undefined);
  }, [latest.data, submittedAudit]);

  async function startAudit(target = url) {
    if (!owner || !available || starting || isActive) return;
    setActionError(undefined);
    let normalized: URL;
    try {
      normalized = new URL(target.trim());
      if (!['https:', 'http:'].includes(normalized.protocol) || normalized.username || normalized.password) throw new Error();
    } catch {
      setActionError(new Error('Enter a complete public website URL, starting with https:// or http://.'));
      return;
    }
    setStarting(true);
    try {
      const result = await idempotentPost<{ audit: WebsiteHealthAudit }>(collectionPath, { url: normalized.href });
      setSubmittedAudit(result.audit);
      setSelectedId(result.audit.id);
      setUrl(result.audit.url);
      setDevice('mobile');
      setCategory('all');
      void invalidateApiQueries(`${path}/website-health`);
      notify('Website audit queued for mobile and desktop. Results will appear here as each device finishes.');
    } catch (error) { setActionError(error instanceof Error ? error : new Error('The audit could not be started. Please try again.')); }
    finally { setStarting(false); }
  }
  async function copyChecklist() {
    if (!audit) return;
    const value = websiteHealthChecklist(audit, device);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      notify('Developer checklist copied.');
    } catch { setChecklist(value); }
  }
  function selectAudit(item: WebsiteHealthAudit) {
    setSelectedId(item.id);
    setUrl(item.url);
    initialUrlSet.current = true;
    setCategory('all');
  }

  return <div className="website-health">
    <header className="health-heading"><div><div className="eyebrow">A BETTER WEBSITE EXPERIENCE</div><h1>Website Health</h1><p>Find what to improve. See the difference on mobile and desktop.</p></div><span className="health-powered"><Gauge size={15} /> Powered by Google PageSpeed &amp; CrUX</span></header>
    <section className="card health-run-card" aria-labelledby="health-run-title">
      <div className="health-run-intro"><span className="health-run-icon"><Activity size={21} /></span><div><h2 id="health-run-title">Give your website a checkup</h2><p>Audit your homepage or a landing page. Every check includes both devices.</p></div></div>
      <form onSubmit={event => { event.preventDefault(); void startAudit(); }} className="health-run-form">
        <label htmlFor="health-page-url">Page URL</label><div className="health-url-row"><div className="health-url-input"><Globe2 size={16} aria-hidden="true" /><input id="health-page-url" type="url" required placeholder="https://example.com/" value={url} onChange={event => { initialUrlSet.current = true; setUrl(event.target.value); }} disabled={!owner} autoComplete="url" spellCheck={false} aria-describedby="health-audit-help" /></div><button className="button button-primary" type="submit" disabled={!owner || !available || starting || isActive || !url.trim()}>{starting || isActive ? <LoaderCircle size={15} className="spinner" /> : <Play size={14} />}{starting ? 'Starting…' : isActive ? 'Audit in progress' : 'Run audit'}</button></div>
        <p id="health-audit-help" className="health-help">{project.demo ? 'This demo is read-only. Website audits are available for your own account.' : !owner ? 'Account owners can run audits. You can explore saved reports below.' : latest.data && !available ? 'Website auditing is not connected yet. Ask your administrator to enable Google PageSpeed for this workspace.' : 'A check usually takes a few minutes. Public pages on your account’s website only.'}</p>
      </form>
      <ErrorNotice error={actionError} />
    </section>
    <ErrorNotice error={latest.error} retry={() => void invalidateApiQueries(`${path}/website-health`)} />
    {latest.loading && !latest.data ? <Skeleton variant="cards" label="Loading saved website audits…" /> : !audit && !latest.error ? <div className="card health-empty"><Empty title="Your next improvement starts here" description="Run your first website audit to get device-specific scores, real-user measurements where available, and a prioritized checklist of fixes." /><div className="health-empty-benefits"><span><Smartphone size={17} /> Mobile &amp; desktop</span><span><ListIcon /> Four quality checks</span><span><Sparkles size={17} /> Actionable improvements</span></div></div> : audit ? <div className="health-workspace">
      <aside className="card health-history" aria-labelledby="health-history-title"><div className="health-history-heading"><h2 id="health-history-title"><Clock3 size={16} /> Saved audits</h2><span>{latest.data?.total ?? history.length}</span></div><div className="health-history-items">{history.map(item => <button key={item.id} className={`health-history-item${reportId === item.id ? ' selected' : ''}`} aria-pressed={reportId === item.id} onClick={() => selectAudit(item)}><span className="health-history-date">{formatDate(item.createdAt, true)}<span className={`health-status ${item.status}`}>{auditLabel(item.status)}</span></span><span className="health-history-url" title={item.url}>{item.url}</span><span className="health-history-devices"><Smartphone size={12} /> Mobile <i /> <Monitor size={12} /> Desktop</span></button>)}</div>{nextCursor && <button className="button button-quiet health-load-more" disabled={older.loading} onClick={() => setCursor(nextCursor)}>{older.loading ? <LoaderCircle size={13} className="spinner" /> : <ChevronDown size={13} />}Load older audits</button>}<ErrorNotice error={older.error} retry={() => void invalidateApiQueries(`${path}/website-health`)} /></aside>
      <div className="health-report">
        <div className="health-report-heading"><div><span className="health-kicker">AUDIT REPORT · {formatDate(audit.createdAt, true)}</span><h2>{safeUrl(audit.url) ? <a href={audit.url} target="_blank" rel="noopener noreferrer">{audit.url}<ExternalLink size={13} /></a> : audit.url}</h2><p className="health-report-meta"><span className={`health-status ${audit.status}`}>{auditLabel(audit.status)}</span>{active(audit) ? 'Results update automatically as each device finishes.' : 'Saved results · Run another audit after making changes.'}</p></div>{owner && <button className="button button-outline" disabled={!available || starting || isActive} onClick={() => void startAudit(audit.url)}><RefreshCw size={13} />Recheck page</button>}</div>
        <ErrorNotice error={details.error} retry={() => void invalidateApiQueries(`${path}/website-health`)} />
        <div className="health-device-row"><div className="health-device-toggle" aria-label="Audit device"><button aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone size={16} />Mobile</button><button aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor size={16} />Desktop</button></div><span><span className={`health-status ${current?.status}`}>{current?.status === 'completed' ? 'Device complete' : current?.status === 'failed' ? 'Device failed' : current?.status === 'running' ? 'Testing device' : 'Device queued'}</span></span></div>
        {current?.status === 'failed' && <div className="health-notice warning" role="status"><AlertTriangle size={18} /><div><strong>{deviceLabels[device]} audit could not finish</strong><p>{current.error?.message || 'This page could not be tested. Check that it is publicly accessible, then recheck the page.'}</p></div></div>}
        {current && ['queued', 'running'].includes(current.status) && <div className="health-notice" role="status"><LoaderCircle size={18} className="spinner" /><div><strong>{current.status === 'queued' ? `${deviceLabels[device]} audit is queued` : `Testing your ${deviceLabels[device].toLowerCase()} experience`}</strong><p>Google is checking performance, accessibility, best practices and SEO. You can leave this screen and return to the saved report.</p></div></div>}
        {audit.summaryOnly ? (details.error ? <div className="card health-detail-error"><p className="health-note">Report details could not be loaded. Use Try again above to retrieve this saved report.</p></div> : <Skeleton variant="cards" label="Loading this audit’s measurements and recommendations…" />) : <>
        <div className="health-score-grid">{categories.map(item => {
          const value = lab?.scores[item.id];
          const oldValue = previous?.results[device].lab?.scores[item.id];
          const change = value != null && oldValue != null ? value - oldValue : undefined;
          return <section className={`card health-score ${scoreRating(value)}`} key={item.id} aria-label={`${item.label} score`}><span className="health-score-label">{item.label}</span><div className="health-score-number">{value == null ? '—' : value}<small>{value == null ? 'Not measured' : '/ 100'}</small></div><span className="health-score-rating">{ratingLabel(scoreRating(value))}</span>{change != null && <span className={`health-score-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`} title={`Compared with the previous completed ${deviceLabels[device].toLowerCase()} audit of this URL on ${formatDate(previous!.createdAt, true)}`}>{change > 0 ? <ArrowUp size={12} /> : change < 0 ? <ArrowDown size={12} /> : null}{change === 0 ? 'No score change' : `${Math.abs(change)} ${Math.abs(change) === 1 ? 'point' : 'points'}`}<span className="sr-only">{change > 0 ? ' improved' : change < 0 ? ' decreased' : ''} vs previous {deviceLabels[device].toLowerCase()} report for the same URL</span></span>}</section>;
        })}</div>
        {lab && <p className="health-comparison-note">{previous ? `Score changes compare with the previous ${deviceLabels[device].toLowerCase()} report for this URL (${formatDate(previous.createdAt, true)}).` : 'No earlier completed report for this URL and device in the loaded history.'} Lab scores can vary between runs.</p>}
        <FieldMetrics field={current?.field} cruxAvailable={latest.data?.cruxAvailable === true} />
        <section className="card health-lab" aria-labelledby="health-lab-title"><div className="health-section-heading"><div><span className="health-kicker"><Gauge size={13} /> CONTROLLED TEST</span><h2 id="health-lab-title">Lab performance</h2><p>A simulated {deviceLabels[device].toLowerCase()} visit helps diagnose what to fix.</p></div><span className="health-source">PageSpeed</span></div>{lab?.metrics.length ? <MetricGrid metrics={lab.metrics} /> : <p className="health-note">{current?.status === 'failed' ? 'No lab measurements were returned for this device.' : 'Lab measurements will appear when this device audit finishes.'}</p>}{lab && <p className="health-lab-caption">Tested {formatDate(lab.fetchedAt, true)} · Lighthouse {lab.lighthouseVersion}{lab.finalUrl !== audit.url && <> · Final page: <span>{lab.finalUrl}</span></>}</p>}{lab?.warnings.map((warning, index) => <p className="health-note health-warning" key={index}><AlertTriangle size={13} />{warning}</p>)}</section>
        <section className="card health-improvements" aria-labelledby="health-improvements-title"><div className="health-section-heading"><div><span className="health-kicker"><Sparkles size={13} /> YOUR NEXT STEPS</span><h2 id="health-improvements-title">What to improve{lab ? <span className="health-count">{issues.length}</span> : null}</h2><p>Prioritized recommendations for your {deviceLabels[device].toLowerCase()} experience.</p></div><button className="button button-outline" onClick={() => void copyChecklist()} disabled={!lab || !issues.length}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? 'Copied' : 'Copy for developer'}</button></div>
          {lab && issues.length > 0 && <><div className="health-issue-filters" aria-label="Filter recommendations"><button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All fixes</button>{categories.map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div><p className="health-estimate-note">Potential savings are Google’s estimates and can overlap. They are not guaranteed or additive.</p></>}
          <div className="health-issues">{visibleIssues.map((issue, index) => <details className="health-issue" key={`${issue.category}-${issue.id}`} open={index === 0 || undefined}><summary><span className={`health-priority ${issue.priority}`}>{issue.priority}</span><span className="health-issue-title">{issue.title}<small>{categories.find(item => item.id === issue.category)?.label}</small></span>{issueSavings(issue) && <span className="health-savings">Save ~{issueSavings(issue)}</span>}<ChevronDown size={15} /></summary><div className="health-issue-body"><AnswerMarkdown text={issue.description} />{issue.resources.length > 0 && <div className="health-resources"><h3>Affected resources</h3><ul>{issue.resources.map((resource, resourceIndex) => <li key={resourceIndex}>{resource}</li>)}</ul></div>}</div></details>)}</div>
          {!lab ? <p className="health-note">{current?.status === 'failed' ? 'Recommendations are unavailable for this device. Recheck the page to try again.' : 'Your improvement checklist will appear after the audit.'}</p> : issues.length === 0 ? <div className="health-no-issues"><CheckCircle2 size={24} /><strong>No actionable issues were returned</strong><p>Review your measurements and test important user journeys as well.</p></div> : visibleIssues.length === 0 ? <p className="health-note">No recommendations in this category.</p> : null}
          {checklist && <div className="health-copy-fallback"><label htmlFor="health-checklist-copy">Select and copy your developer checklist</label><textarea id="health-checklist-copy" value={checklist} readOnly onFocus={event => event.currentTarget.select()} rows={10} /></div>}
        </section>
        </>}
      </div>
    </div> : null}
    <p className="health-footer"><Info size={13} /> Audits assess a single public page. Scores and automated checks help guide improvements; they do not guarantee search rankings or full accessibility.</p>
  </div>;
}
function ListIcon() { return <CheckCircle2 size={17} />; }
