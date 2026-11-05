import { hasExcerptOmissions, reportExcerpt } from './report-excerpt';
import { reportReference } from './report-reference';
import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, ExternalLink as ExternalLinkIcon, Link2, LoaderCircle, RefreshCw, Search, ShieldCheck, Upload } from 'lucide-react';
import {
  GEO_BACKLINK_STATUSES, PROVIDER_LABELS, SCAN_PROVIDERS,
  type Project, type GeoBacklinkActivity, type GeoBacklinkMonthlyReport,
  type GeoBacklinkRecommendation, type GeoBacklinkPerformanceSnapshot,
  type GeoBacklinkPerformanceMetrics, type GeoBacklinkStatus, type ScanProvider,
} from '@citevia/core';
import { idempotentPost, query, request, useApi } from './api';
import { Drawer, Empty, ErrorNotice, ExternalLink, formatDate, formatNumber, labelize, Pagination } from './components';
import { Skeleton } from './Loading';
import { invalidateApiQueries } from './query-cache';
import './geo-backlinks.css';

interface ResultPage<T> { items: T[]; total: number }
interface ReportDetail { report: GeoBacklinkMonthlyReport | null; recommendations: GeoBacklinkRecommendation[] }
interface RecommendationDetail { recommendation: GeoBacklinkRecommendation; activities: GeoBacklinkActivity[]; activityTotal?: number; snapshots: GeoBacklinkPerformanceSnapshot[] }
export interface GeoBacklinkProgress {
  evaluatedAt?: string | null; pending?: boolean; caveat?: string; comparablePromptCount?: number; excludedChangedPrompts?: number;
  months: { month: string; recommendationCount: number; contactedCount: number; acceptedCount: number; publishedCount: number; metrics: GeoBacklinkPerformanceMetrics; providers?: Partial<Record<ScanProvider, GeoBacklinkPerformanceMetrics>> }[];
  placements: { recommendation: GeoBacklinkRecommendation; snapshots: GeoBacklinkPerformanceSnapshot[] }[];
}
const categories = { competitor_gap: 'Competitor coverage gap', underrepresented: 'Underrepresented brand', coverage_gap: 'New or outdated coverage', secondary: 'Secondary opportunity' };
const priorities = ['P1', 'P2', 'P3', 'P4'] as const;
const rate = (value: number | null | undefined) => value == null ? 'Not measured' : `${formatNumber(value, 1)}%`;
const dateInput = (value: string | null) => value?.slice(0, 10) || '';
const savedDate = (value: string, original: string | null) => !value ? null : value === dateInput(original) ? original : `${value}T00:00:00.000Z`;
const accountDate = (date: string, timezone: string) => new Date(date).toLocaleDateString('en', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' });
const monthLabel = (month: string) => /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : month;
function currentMonth(timezone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}`;
}
function Priority({ value }: { value: string }) { return <span className={`geo-priority geo-${value.toLowerCase()}`}>{value}</span>; }

export default function GeoBacklinksView(props: { project: Project; systemAdmin: boolean; notify: (message: string) => void }) {
  if (!props.systemAdmin) return <Empty title="Administrator access required" description="Only system administrators can prepare monthly GEO backlink strategies." />;
  if (!props.project.geoBacklinks?.enabled) return <Empty title="Enable your monthly strategy" description="Turn on GEO Backlink Strategy in this project’s settings to prepare a monthly plan."><a className="button button-outline" href="#settings">Open project settings</a></Empty>;
  return <AdminGeoBacklinks key={props.project.id} {...props} />;
}

function AdminGeoBacklinks({ project, notify }: { project: Project; notify: (message: string) => void }) {
  const base = `/projects/${encodeURIComponent(project.id)}/geo-backlinks`;
  const [view, setView] = useState<'monthly' | 'history' | 'progress'>('monthly');
  const [month, setMonth] = useState(() => currentMonth(project.timezone));
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recommendedAt');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [activityPage, setActivityPage] = useState(0);
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<Error>();
  const report = useApi<ReportDetail>(view === 'monthly' && month ? `${base}/reports/${month}` : null);
  const recommendations = useApi<ResultPage<GeoBacklinkRecommendation>>(view === 'history' || (view === 'monthly' && month) ? `${base}/recommendations${query({ offset: page * 25, limit: 25, month: view === 'monthly' ? month : undefined, priority, category, provider, status, q: search, sort, direction: sort === 'domain' ? 'asc' : 'desc' })}` : null);
  const detail = useApi<RecommendationDetail>(selected ? `${base}/recommendations/${encodeURIComponent(selected)}${query({ offset: activityPage * 25, limit: 25 })}` : null);
  const active = report.data?.report && ['queued', 'running'].includes(report.data.report.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void invalidateApiQueries(base), 4000);
    return () => clearInterval(timer);
  }, [active, base]);
  useEffect(() => {
    if (recommendations.data && page > 0 && page * 25 >= recommendations.data.total) setPage(0);
  }, [recommendations.data, page]);
  function changeFilter(set: (value: string) => void, value: string) { set(value); setPage(0); }
  async function generate() {
    if (generating || !month) return;
    setGenerating(true); setError(undefined);
    try {
      const result = await idempotentPost<{ report: GeoBacklinkMonthlyReport }>(`${base}/reports`, { month });
      notify(['completed', 'insufficient_data'].includes(result.report.status) ? 'Saved monthly report opened.' : 'Preparing this month’s strategy from existing scans.');
      await invalidateApiQueries(base);
    } catch (failure) { setError(failure as Error); }
    finally { setGenerating(false); }
  }
  return <div className="geo-screen">
    <header className="geo-heading"><div><div className="eyebrow"><ShieldCheck size={13} /> SYSTEM ADMIN</div><h1>GEO Backlink Strategy</h1><p>New websites to approach, evidence behind each opportunity, and progress for {reportExcerpt(project.name)}.</p></div><button className="button button-outline" onClick={() => void invalidateApiQueries(base)}><RefreshCw size={14} /> Refresh</button></header>
    <div className="geo-method"><CalendarDays size={19} /><p>Monthly plans use the previous month’s completed AI scans. Recommended domains are excluded for {project.geoBacklinks?.exclusionDays ?? 180} days. Saved monthly selections stay fixed.</p><span>1st · 06:00<br />{project.timezone}</span></div>
    <nav className="geo-tabs" aria-label="Backlink strategy views">{([['monthly', 'Monthly recommendations'], ['history', 'Recommendation history'], ['progress', 'GEO progress & analytics']] as const).map(([key, label]) => <button key={key} aria-current={view === key ? 'page' : undefined} onClick={() => { setView(key); setPage(0); }}>{label}</button>)}</nav>
    {view === 'progress' ? <Progress base={base} notify={notify} /> : <>
      <div className="geo-period"><div>{view === 'monthly' ? <label>Recommendation month<input aria-label="Recommendation month" type="month" value={month} max={currentMonth(project.timezone)} onChange={event => changeFilter(setMonth, event.target.value)} /></label> : <div><h2>Every recorded recommendation</h2><p>Including rejected, unpublished, and imported history.</p></div>}</div>{view === 'monthly' ? <button className="button button-primary" disabled={generating || Boolean(active) || !month || Boolean(project.demo)} onClick={() => void generate()}>{generating || active ? <LoaderCircle size={14} className="spinner" /> : <Link2 size={14} />}{generating || active ? 'Preparing strategy…' : report.data?.report && report.data.report.status !== 'failed' ? 'Open saved report' : 'Prepare monthly strategy'}</button> : <button className="button button-outline" onClick={() => setImporting(true)} disabled={Boolean(project.demo)}><Upload size={14} /> Import history</button>}</div>
      <ErrorNotice error={error || report.error} retry={() => void invalidateApiQueries(base)} />
      {view === 'monthly' && report.loading && !report.data && <Skeleton variant="cards" label="Loading monthly strategy…" />}
      {view === 'monthly' && report.data?.report && <ReportSummary report={report.data.report} />}
      <div className="geo-toolbar"><label className="geo-search"><Search size={15} /><input aria-label="Search recommendations" type="search" placeholder="Search websites…" maxLength={200} value={search} onChange={event => changeFilter(setSearch, event.target.value)} /></label><select aria-label="Filter priority" value={priority} onChange={event => changeFilter(setPriority, event.target.value)}><option value="">All priorities</option>{priorities.map(item => <option key={item}>{item}</option>)}</select><select aria-label="Filter category" value={category} onChange={event => changeFilter(setCategory, event.target.value)}><option value="">All categories</option>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Filter provider" value={provider} onChange={event => changeFilter(setProvider, event.target.value)}><option value="">All AI platforms</option>{SCAN_PROVIDERS.map(id => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}</select><select aria-label="Filter status" value={status} onChange={event => changeFilter(setStatus, event.target.value)}><option value="">All statuses</option>{GEO_BACKLINK_STATUSES.map(id => <option key={id} value={id}>{labelize(id)}</option>)}</select><select aria-label="Sort recommendations" value={sort} onChange={event => changeFilter(setSort, event.target.value)}><option value="recommendedAt">Most recent</option><option value="score">Highest score</option><option value="domain">Website A–Z</option><option value="eligibleAgainAt">Eligibility date</option></select></div>
      <ErrorNotice error={recommendations.error} retry={() => void invalidateApiQueries(base)} />
      {recommendations.loading && !recommendations.data ? <Skeleton variant="table" label="Loading recommendations…" /> : recommendations.data?.items.length ? <><div className="geo-table-wrap"><table className="geo-table"><thead><tr>{['Priority / score', 'Website & article', 'Opportunity', 'Article evidence', 'AI citations', 'Action', 'Status / eligibility'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{recommendations.data.items.map(item => <RecommendationRow key={item.id} item={item} history={view === 'history'} open={() => { setActivityPage(0); setSelected(item.id); }} />)}</tbody></table></div><Pagination page={page} total={recommendations.data.total} size={25} onChange={setPage} /></> : recommendations.data && !recommendations.error && <Empty title={priority || category || provider || status || search ? 'No recommendations match these filters' : view === 'monthly' ? 'No new websites selected yet' : 'Your history starts with a recorded recommendation'} description={view === 'monthly' ? 'Prepare this month’s strategy from available scan evidence. A report can contain fewer websites when data or eligible opportunities are limited.' : 'Monthly recommendations remain here throughout outreach and performance tracking. Import documented earlier recommendations to enforce their exclusion dates.'} />}
      {view === 'history' && <p className="geo-footnote">The exclusion guarantee covers recorded recommendations only. Import trustworthy historical dates before preparing a new plan.</p>}
    </>}
    {selected && <Drawer title="Backlink opportunity" wide onClose={() => setSelected(undefined)}><ErrorNotice error={detail.error} retry={() => void invalidateApiQueries(base)} />{detail.data ? <RecommendationDetails key={`${detail.data.recommendation.id}-${detail.data.recommendation.version}`} detail={detail.data} activityPage={activityPage} onActivityPage={setActivityPage} base={base} disabled={Boolean(project.demo)} notify={notify} /> : !detail.error && <Skeleton variant="detail" label="Loading opportunity evidence…" />}</Drawer>}
    {importing && <HistoryImport base={base} onClose={() => setImporting(false)} notify={notify} />}
  </div>;
}

function ReportSummary({ report }: { report: GeoBacklinkMonthlyReport }) {
  return <section className="geo-report" aria-label="Monthly report summary"><div><strong>{monthLabel(report.month)}</strong><span className={`tag ${report.status}`}>{labelize(report.status)}</span></div><p>Analysis: {accountDate(report.analysisStart, report.timezone)} – {accountDate(new Date(Date.parse(report.analysisEnd) - 1).toISOString(), report.timezone)} · {report.timezone}</p><dl className="geo-stats"><div><dt>Distinct scans</dt><dd>{report.scanCount}</dd></div><div><dt>Analyzed answers</dt><dd>{report.answerCount}</dd></div><div><dt>Candidates evaluated</dt><dd>{report.candidateCount}</dd></div><div><dt>New websites</dt><dd>{report.selectedRecommendationIds.length} <small>/ {report.settings.target}</small></dd></div></dl>{report.warnings.map((warning, index) => <p className="geo-note" key={index}>{reportExcerpt(warning)}</p>)}{report.error && <ErrorNotice error={report.error} />}<p className="geo-footnote">{report.generatedAt ? `Generated ${formatDate(report.generatedAt, true)} · ` : ''}{report.algorithmVersion}</p></section>;
}

function RecommendationRow({ item, history, open }: { item: GeoBacklinkRecommendation; history: boolean; open: () => void }) {
  const candidate = item.candidate, article = candidate?.evidence.article;
  return <tr><td><Priority value={item.priority} /><strong className="geo-score">{candidate ? `${formatNumber(candidate.score, 1)} / 100` : 'Imported'}</strong>{history && <small>{monthLabel(item.month)}</small>}</td><td><button className="geo-domain" onClick={open}>{reportExcerpt(item.domain)}</button><ExternalLink url={item.url}>{reportExcerpt(candidate?.title || 'Original article')}</ExternalLink><small className="geo-url">{reportExcerpt(item.url)}</small></td><td>{candidate ? categories[candidate.category] : 'Historical recommendation'}{candidate?.evidence.prompts.length ? <small>{candidate.evidence.prompts.length} tracked prompt{candidate.evidence.prompts.length === 1 ? '' : 's'}</small> : null}</td><td><span>Customer: <strong>{article ? labelize(article.brandPresence) : 'Unknown'}</strong></span><small>Competitors: {article?.status === 'verified' ? article.competitors.map(item => reportExcerpt(item.name)).join(', ') || 'None verified' : 'Unknown'}</small></td><td>{candidate ? <><strong>{candidate.evidence.distinctScans} / {candidate.evidence.totalScans} scans</strong><small>{rate(candidate.evidence.citationConsistency)} consistency</small><small>{candidate.evidence.providers.map(id => PROVIDER_LABELS[id]).join(', ')}</small></> : 'Not recorded'}</td><td>{reportExcerpt(candidate?.action || 'Review historical outreach notes')}<button className="geo-text-button" onClick={open}>Evidence & update <ExternalLinkIcon size={11} /></button></td><td><span className={`tag ${item.status}`}>{labelize(item.status)}</span><small>Eligible again {formatDate(item.eligibleAgainAt, true)}</small>{item.publishedUrl && <ExternalLink url={item.publishedUrl}>Published placement</ExternalLink>}</td></tr>;
}

function RecommendationDetails({ detail, activityPage, onActivityPage, base, disabled, notify }: { detail: RecommendationDetail; activityPage: number; onActivityPage: (page: number) => void; base: string; disabled: boolean; notify: (message: string) => void }) {
  const { recommendation: item } = detail;
  const candidate = item.candidate, article = candidate?.evidence.article;
  return <div className="geo-detail"><header><Priority value={item.priority} /><h2>{reportExcerpt(item.domain)}</h2><ExternalLink url={item.url}>{reportExcerpt(candidate?.title || item.url)}</ExternalLink><p>Recommended {formatDate(item.recommendedAt, true)} · Eligible again {formatDate(item.eligibleAgainAt, true)}</p></header>
    {candidate ? <><section><h3>Why this website</h3><ul>{candidate.explanation.map((reason, index) => <li key={index}>{reportExcerpt(reason)}</li>)}</ul><p className="geo-note"><strong>Recommended action:</strong> {reportExcerpt(candidate.action)}</p><dl className="geo-score-breakdown">{Object.entries(candidate.scoreBreakdown).map(([factor, value]) => <div key={factor}><dt>{factor.replace(/([A-Z])/g, ' $1')}</dt><dd>{formatNumber(value, 1)}</dd></div>)}<div><dt>Total score</dt><dd>{formatNumber(candidate.score, 1)} / 100</dd></div></dl></section>
      <section><h3>Verified article evidence</h3><p>These observations describe the publisher’s page. AI answers are shown separately below.</p><dl className="geo-evidence-grid"><div><dt>Verification</dt><dd>{article?.status === 'verified' ? `Verified ${formatDate(article.verifiedAt, true)}` : 'Unavailable — presence unknown'}</dd></div><div><dt>Customer presence</dt><dd>{labelize(article?.brandPresence || 'unknown')}</dd></div><div><dt>Competitors in article</dt><dd>{article?.status === 'verified' ? article.competitors.map(item => reportExcerpt(item.name)).join(', ') || 'None verified' : 'Unknown'}</dd></div><div><dt>Link to customer</dt><dd>{article?.hasBrandLink == null ? 'Unknown' : article.hasBrandLink ? 'Confirmed' : 'Not found in verified page'}</dd></div><div><dt>Publisher</dt><dd>{reportExcerpt(article?.publisher || 'Unknown')}</dd></div><div><dt>Customer article position</dt><dd>{article?.brandPosition == null ? 'Unknown — no editorial ranking verified' : article.brandPosition}</dd></div><div><dt>Article mention counts</dt><dd>{article?.status === 'verified' ? `Customer: ${article.brandMentions ?? 'unknown'}; ${article.competitors.map(competitor => `${reportExcerpt(competitor.name)}: ${competitor.mentions ?? 'unknown'}`).join('; ') || 'no competitor mentions verified'}` : 'Unknown'}</dd></div><div><dt>Topic / market relevance</dt><dd>{article?.topicRelevant == null ? 'Topic unknown' : article.topicRelevant ? 'Topic verified' : 'Topic mismatch'} · {article?.marketRelevant == null ? 'market unknown' : article.marketRelevant ? 'market verified' : 'market mismatch'}</dd></div><div><dt>Placement availability</dt><dd>{article?.placementOpportunity === 'unknown' ? 'Unknown' : labelize(article?.placementOpportunity || 'unknown')}</dd></div></dl>{article?.reason && <p className="geo-note">{reportExcerpt(article.reason)}</p>}{article?.excerpts.map((text, index) => <blockquote key={index}>{reportExcerpt(text)}</blockquote>)}{article?.links.map((link, index) => <p key={index}><ExternalLink url={link.url}>{reportExcerpt(link.url)}</ExternalLink> · {labelize(link.type)}</p>)}</section>
      <section><h3>AI answer evidence</h3><details className="geo-tracked-prompts"><summary>Tracked prompts and topics</summary><ul>{candidate.evidence.prompts.map(prompt => <li key={`${prompt.id}-${prompt.version}`}>{reportExcerpt(prompt.text)} · version {prompt.version}{prompt.topic ? ` · ${reportExcerpt(prompt.topic)}` : ''}</li>)}</ul></details><p>{candidate.evidence.distinctScans} distinct scans cite this article. Customer mention rate: {rate(candidate.evidence.aiBrandMentionRate)}. Average customer position when mentioned: {formatNumber(candidate.evidence.aiAverageBrandRank, 1)}.</p><p>Competitors appearing in associated AI answers: {reportExcerpt(candidate.evidence.aiCompetitors.join(', ') || 'None recorded')}.</p><div className="geo-observations">{candidate.evidence.observations.map(observation => <details key={observation.key}><summary>{PROVIDER_LABELS[observation.provider]} · {formatDate(observation.at, true)} · {reportExcerpt(observation.promptText)}</summary><dl><dt>Prompt version</dt><dd>{observation.promptVersion}</dd><dt>Customer mentioned in this answer</dt><dd>{observation.brandMentioned == null ? 'Unknown' : observation.brandMentioned ? 'Yes' : 'No'}</dd><dt>Customer rank</dt><dd>{formatNumber(observation.brandRank)}</dd><dt>Scan / response</dt><dd className="geo-url">{reportReference(observation.runId)} / {reportReference(observation.responseId)}</dd></dl>{observation.citations.map((citation, index) => <p key={index}><ExternalLink url={citation.url}>{reportExcerpt(citation.title || citation.url)}</ExternalLink></p>)}</details>)}</div></section>
    </> : <p className="geo-note">Imported recommendation. Original evidence was not recorded in Citevia. Source: {reportExcerpt(item.importSource || 'Historical import')}.</p>}
    <LifecycleForm item={item} base={base} disabled={disabled} notify={notify} />
    <section><h3>Status history</h3>{detail.activities.length ? <ol className="geo-audit">{detail.activities.map(activity => <li key={activity.id}><strong>{labelize(activity.action)} · {labelize(activity.toStatus)}</strong><span>{formatDate(activity.at, true)} · {reportReference(activity.actorId)}</span>{Object.entries(activity.changes).map(([field, change]) => <small key={field}>{labelize(field)}: {reportExcerpt(String(change.from ?? '—'))} → {reportExcerpt(String(change.to ?? '—'))}</small>)}</li>)}</ol> : <p>No earlier changes recorded.</p>}{(detail.activityTotal ?? 0) > 25 && <Pagination page={activityPage} total={detail.activityTotal!} size={25} onChange={onActivityPage} />}</section>
    {item.publishedAt && <section><h3>Publication checkpoints</h3><Checkpoints snapshots={detail.snapshots} publication={item.publishedAt} publicationUrl={item.publishedUrl} /></section>}
  </div>;
}

function LifecycleForm({ item, base, disabled, notify }: { item: GeoBacklinkRecommendation; base: string; disabled: boolean; notify: (message: string) => void }) {
  const [status, setStatus] = useState(item.status);
  const [notes, setNotes] = useState(item.notes);
  const [editingOriginal, setEditingOriginal] = useState(false);
  const hasHiddenFields = [item.notes, item.ownerId, item.publishedUrl, item.landingPage, item.placementType]
    .some(text => text && hasExcerptOmissions(text));
  const readOnly = disabled || (hasHiddenFields && !editingOriginal);
  const fieldValue = (value: string) => readOnly ? reportExcerpt(value) : value;
  const [ownerId, setOwnerId] = useState(item.ownerId || '');
  const [contactedAt, setContactedAt] = useState(dateInput(item.contactedAt));
  const [publishedAt, setPublishedAt] = useState(dateInput(item.publishedAt));
  const [publishedUrl, setPublishedUrl] = useState(item.publishedUrl || '');
  const [landingPage, setLandingPage] = useState(item.landingPage || '');
  const [placementType, setPlacementType] = useState(item.placementType || '');
  const [linkType, setLinkType] = useState(item.linkType);
  const [cost, setCost] = useState(item.cost == null ? '' : String(item.cost));
  const [currency, setCurrency] = useState(item.currency || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || readOnly) return;
    setBusy(true); setError(undefined);
    try {
      await request(`${base}/recommendations/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ version: item.version, status, notes, ownerId: ownerId || null, contactedAt: savedDate(contactedAt, item.contactedAt), publishedAt: savedDate(publishedAt, item.publishedAt), publishedUrl: publishedUrl || null, landingPage: landingPage || null, placementType: placementType || null, linkType, cost: cost === '' ? null : Number(cost), currency: currency || null }) });
      setEditingOriginal(false); notify('Outreach and publication details saved.'); await invalidateApiQueries(base);
    } catch (failure) { setError(failure as Error); } finally { setBusy(false); }
  }
  return <section><h3>Outreach & publication</h3>{hasHiddenFields && !disabled && !editingOriginal && <button type="button" className="button button-outline" onClick={() => setEditingOriginal(true)}>Edit details</button>}<form className="geo-form" onSubmit={event => void save(event)}><ErrorNotice error={error} /><fieldset disabled={busy || readOnly}><div className="geo-form-grid"><label>Status<select value={status} onChange={event => setStatus(event.target.value as GeoBacklinkStatus)}>{GEO_BACKLINK_STATUSES.map(value => <option key={value} value={value}>{labelize(value)}</option>)}</select></label><label>Owner / responsible user ID<input value={fieldValue(ownerId)} maxLength={200} onChange={event => setOwnerId(event.target.value)} /></label><label>Contacted date (UTC)<input type="date" value={contactedAt} onChange={event => setContactedAt(event.target.value)} /></label><label>Publication date (UTC)<input required={status === 'published'} type="date" value={publishedAt} onChange={event => setPublishedAt(event.target.value)} /></label><label>Published URL<input type="url" required={status === 'published'} value={fieldValue(publishedUrl)} onChange={event => setPublishedUrl(event.target.value)} placeholder="https://publisher.com/article" /></label><label>Customer landing page<input type="url" value={fieldValue(landingPage)} onChange={event => setLandingPage(event.target.value)} placeholder="https://your-website.com/page" /></label><label>Placement type<input value={fieldValue(placementType)} maxLength={200} onChange={event => setPlacementType(event.target.value)} placeholder="Editorial inclusion, sponsored…" /></label><label>Link attribute<select value={linkType} onChange={event => setLinkType(event.target.value as typeof linkType)}>{['unknown', 'follow', 'nofollow', 'sponsored', 'ugc'].map(value => <option key={value} value={value}>{labelize(value)}</option>)}</select></label><label>Placement cost<input type="number" min="0" step="0.01" value={cost} onChange={event => setCost(event.target.value)} /></label><label>Currency<input required={cost !== ''} value={currency} maxLength={3} pattern="[A-Z]{3}" placeholder="USD" onChange={event => setCurrency(event.target.value.toUpperCase())} /></label></div><label>Notes<textarea rows={4} maxLength={10000} value={fieldValue(notes)} onChange={event => setNotes(event.target.value)} /></label><button className="button button-primary" type="submit">{busy ? 'Saving…' : 'Save progress'}</button></fieldset></form></section>;
}

function HistoryImport({ base, onClose, notify }: { base: string; onClose: () => void; notify: (message: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const items: unknown = JSON.parse(value);
      if (!Array.isArray(items) || !items.length) throw new Error('Provide a nonempty JSON array of historical recommendations.');
      await idempotentPost(`${base}/history/import`, { items });
      notify('Historical recommendations imported. Their domains now participate in exclusions.');
      await invalidateApiQueries(base); onClose();
    } catch (failure) { setError(failure as Error); } finally { setBusy(false); }
  }
  return <Drawer title="Import recommendation history" onClose={() => { if (!busy) onClose(); }}><form className="geo-form" onSubmit={event => void submit(event)}><p>Paste a JSON array from documented recommendation records. Use the actual recommendation date; imported records will block their registrable domains for the configured exclusion period.</p><p>Each record needs <code>domain</code>, <code>articleUrl</code>, <code>recommendedAt</code> (an ISO date with timezone), <code>priority</code> (P1–P4), and <code>status</code>. Optional <code>notes</code> can identify the source record.</p><ErrorNotice error={error} /><fieldset disabled={busy}><label>Historical recommendation records<textarea rows={14} required spellCheck={false} value={value} onChange={event => setValue(event.target.value)} /></label><button className="button button-primary" type="submit">{busy ? 'Importing…' : 'Import recorded history'}</button></fieldset></form></Drawer>;
}

function Progress({ base, notify }: { base: string; notify: (message: string) => void }) {
  const result = useApi<GeoBacklinkProgress>(`${base}/progress`);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<Error>();
  const [refreshBaseline, setRefreshBaseline] = useState<string | null>();
  const pending = result.data?.pending === true || refreshBaseline !== undefined;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void invalidateApiQueries(`${base}/progress`), 3000);
    return () => clearInterval(timer);
  }, [pending, base]);
  useEffect(() => {
    if (refreshBaseline !== undefined && result.data?.evaluatedAt && result.data.evaluatedAt !== refreshBaseline)
      setRefreshBaseline(undefined);
  }, [refreshBaseline, result.data?.evaluatedAt]);
  async function refreshMeasurements() {
    if (refreshing || pending) return;
    setRefreshing(true); setRefreshError(undefined);
    setRefreshBaseline(result.data?.evaluatedAt ?? null);
    try { await idempotentPost(`${base}/progress/refresh`); notify('Performance refresh queued using existing scan data. Results will update when processing finishes.'); await invalidateApiQueries(base); }
    catch (failure) { setRefreshBaseline(undefined); setRefreshError(failure as Error); }
    finally { setRefreshing(false); }
  }
  const [provider, setProvider] = useState('');
  const [comparison, setComparison] = useState('previous');
  const months = result.data?.months || [];
  const placementEvidence = (result.data?.placements || []).map(({ snapshots, recommendation }) => snapshots.filter(snapshot => snapshot.publicationDate === recommendation.publishedAt && snapshot.publicationUrl === recommendation.publishedUrl).sort((a, b) => b.checkpoint - a.checkpoint)[0]?.article);
  const confirmedLinks = placementEvidence.filter(article => article?.hasBrandLink === true).length;
  const confirmedMentions = placementEvidence.filter(article => article?.brandPresence === 'present').length;
  const unverifiedPlacements = placementEvidence.filter(article => !article || article.status !== 'verified').length;
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const current = sorted.at(-1);
  const compare = comparison === 'baseline' ? sorted[0] : sorted.at(comparison === 'three' ? -4 : -2);
  const metrics = (row?: GeoBacklinkProgress['months'][number]) => provider ? row?.providers?.[provider as ScanProvider] : row?.metrics;
  const currentMetrics = metrics(current), comparedMetrics = metrics(compare);
  const change = currentMetrics?.brandMentionRate != null && comparedMetrics?.brandMentionRate != null ? currentMetrics.brandMentionRate - comparedMetrics.brandMentionRate : null;
  return <div className="geo-progress"><div className="geo-period"><div><h2>Six-month visibility & campaign progress</h2><p>Observed changes in existing scans; publication alone does not establish causation.</p></div><div className="geo-toolbar"><select aria-label="Progress provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="">All AI platforms</option>{SCAN_PROVIDERS.map(id => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}</select><select aria-label="Comparison period" value={comparison} onChange={event => setComparison(event.target.value)}><option value="previous">Compare with previous month</option><option value="baseline">Compare with earliest month</option><option value="three">Compare with three months ago</option></select><button className="button button-outline" disabled={refreshing || pending} onClick={() => void refreshMeasurements()}><RefreshCw size={13} className={refreshing || pending ? 'spinner' : ''} />{refreshing ? 'Queueing refresh…' : pending ? 'Preparing measurements…' : 'Refresh measurements'}</button></div></div><ErrorNotice error={refreshError} /><ErrorNotice error={result.error} retry={() => void invalidateApiQueries(base)} />{pending && <p className="geo-note" role="status">{result.data?.evaluatedAt ? 'Updating measurements from saved scans. The last saved results remain visible below.' : 'Measurements are being prepared from saved scans.'}</p>}{(result.loading && !result.data) || (pending && !result.data?.evaluatedAt && !result.data?.months.length && !result.data?.placements.length) ? <Skeleton variant="cards" label="Loading backlink performance…" /> : !result.data ? null : <>
    <dl className="geo-stats"><div><dt>Current recommendation rate</dt><dd>{rate(currentMetrics?.brandMentionRate)}</dd></div><div><dt>Change vs {compare ? monthLabel(compare.month) : 'comparison'}</dt><dd>{change == null ? 'Not comparable' : `${change > 0 ? '+' : ''}${formatNumber(change, 1)} pp`}</dd></div><div><dt>Average brand position · lower is better</dt><dd>{formatNumber(currentMetrics?.averageBrandRank, 1)}</dd></div><div><dt>Published this cohort</dt><dd>{current?.publishedCount ?? 0}</dd></div></dl>
    <p className="geo-footnote">{result.data.caveat || 'Monthly comparisons use matching AI platforms and prompt versions.'}{result.data.comparablePromptCount != null && <> {result.data.comparablePromptCount} comparable prompt/provider combinations; {result.data.excludedChangedPrompts ?? 0} observations excluded for changed prompts.</>}</p><section className="geo-report"><h3>Monthly cohorts</h3><div className="geo-table-wrap"><table className="geo-table"><thead><tr>{['Month', 'Recommended', 'Contacted', 'Accepted', 'Published', 'AI recommendation rate', 'Average position ↓', 'Referring domains'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{sorted.map(row => <tr key={row.month}><td>{monthLabel(row.month)}</td><td>{row.recommendationCount}</td><td>{row.contactedCount}</td><td>{row.acceptedCount}</td><td>{row.publishedCount}</td><td>{rate(metrics(row)?.brandMentionRate)}</td><td>{formatNumber(metrics(row)?.averageBrandRank, 1)}</td><td>{metrics(row)?.uniqueReferringDomains ?? 'Not measured'}</td></tr>)}</tbody></table></div>{!months.length && <p>No monthly campaign data yet.</p>}<p className="geo-footnote">Referring domains are observed AI citation sources. They are not a count of purchased or confirmed backlinks. Compare publication checkpoints below for matched prompt versions.</p></section>
    {currentMetrics?.competitorRates.length ? <section className="geo-report"><h3>Current competitor recommendation rates</h3><dl className="geo-stats">{currentMetrics.competitorRates.map(competitor => <div key={competitor.id}><dt>{reportExcerpt(competitor.name)}</dt><dd>{rate(competitor.rate)}</dd></div>)}</dl></section> : null}
    <section><h3>Published placements · baseline / 30 / 60 / 90 days</h3><p className="geo-footnote">Latest verified placement evidence: {confirmedLinks} confirmed backlinks · {confirmedMentions} confirmed customer mentions · {unverifiedPlacements} placements awaiting article verification. These are observed totals; they do not imply a gain over baseline.</p>{result.data.placements.length ? result.data.placements.map(({ recommendation, snapshots }) => <article className="geo-report" key={recommendation.id}><h4>{reportExcerpt(recommendation.domain)}</h4><p>{recommendation.publishedUrl && <ExternalLink url={recommendation.publishedUrl}>Published placement</ExternalLink>} · {formatDate(recommendation.publishedAt, true)} · {monthLabel(recommendation.month)} cohort</p><Checkpoints snapshots={snapshots} publication={recommendation.publishedAt!} publicationUrl={recommendation.publishedUrl} provider={provider as ScanProvider || undefined} /></article>) : <Empty title="Track your first published placement" description="Update a recommendation with its publication date and URL. Baseline and 30/60/90-day checkpoints use existing scans with comparable prompt versions." />}</section>
  </>}</div>;
}

function Checkpoints({ snapshots, publication, publicationUrl, provider }: { snapshots: GeoBacklinkPerformanceSnapshot[]; publication: string; publicationUrl: string | null; provider?: ScanProvider }) {
  return <><div className="geo-table-wrap"><table className="geo-table"><thead><tr>{['Checkpoint', 'AI mention rate', 'Change vs baseline', 'Average position ↓', 'Domain citations', 'Article / backlink evidence'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{([0, 30, 60, 90] as const).map(day => {
    const snapshot = snapshots.find(item => item.checkpoint === day && item.publicationDate === publication && item.publicationUrl === publicationUrl);
    const observed = provider ? snapshot?.providers[provider] : snapshot?.metrics;
    const baseline = snapshots.find(item => item.checkpoint === 0 && item.publicationDate === publication && item.publicationUrl === publicationUrl);
    const baselineMetrics = provider ? baseline?.providers[provider] : baseline?.metrics;
    const delta = observed?.brandMentionRate != null && baselineMetrics?.brandMentionRate != null ? observed.brandMentionRate - baselineMetrics.brandMentionRate : null;
    const due = new Date(Date.parse(publication) + day * 86400000);
    return <tr key={day}><td><strong>{day === 0 ? 'Before publication' : `${day} days`}</strong><small>{formatDate(due.toISOString(), true)}</small><small>{snapshot ? labelize(snapshot.status) : due.getTime() > Date.now() ? 'Not due yet' : 'Awaiting measurement'}</small></td><td>{rate(observed?.brandMentionRate)}<small>{observed ? `${observed.answers} comparable answers` : ''}</small></td><td>{delta == null ? 'Not comparable' : `${delta > 0 ? '+' : ''}${formatNumber(delta, 1)} pp`}</td><td>{formatNumber(observed?.averageBrandRank, 1)}</td><td>{observed?.attribution === 'unattributed' ? 'Unattributed' : rate(observed?.domainCitationRate)}</td><td>{snapshot?.article ? `Brand ${snapshot.article.brandPresence}; ${snapshot.article.hasBrandLink == null ? 'link unknown' : snapshot.article.hasBrandLink ? 'link confirmed' : 'no link found'}` : 'Unknown'}{snapshot && <small>{snapshot.excludedChangedPrompts} changed prompt observations excluded</small>}</td></tr>;
  })}</tbody></table></div><p className="geo-footnote">Checkpoints compare matching publication URLs, prompt versions and AI platforms. Lower brand positions are better. Missing citations remain unattributed. Visibility changes show correlation, not proven impact. Referral traffic and conversions remain unmeasured unless an existing integration can attribute them.</p></>;
}
