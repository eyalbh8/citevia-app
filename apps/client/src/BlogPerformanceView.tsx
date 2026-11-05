import { reportExcerpt } from './report-excerpt';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, FileText, LoaderCircle, RefreshCw, Search, ShieldCheck, Sparkles } from 'lucide-react';
import type { AgentPost, BlogPerformance, BlogPerformancePage, BlogOutcome, Project } from '@citevia/core';
import { idempotentPost, query, request, useApi } from './api';
import { Drawer, Empty, ErrorNotice, formatDate, Pagination } from './components';
import { Skeleton } from './Loading';
import { invalidateApiQueries } from './query-cache';
import { PostDetail } from './AgentsView';
import './blog-performance.css';

const outcomes: Record<BlogOutcome, string> = {
  successful: 'Successful', unsuccessful: 'Needs improvement', declining: 'Declining',
  awaiting_data: 'Awaiting evidence', unlinked: 'Link a prompt', paused: 'Paused',
};
const actions = { keep: 'Keep monitoring', adjust: 'Adjust this article', create: 'Create a new article', wait: 'Collect more evidence', link_prompt: 'Link a prompt', resume: 'Resume tracking' };
const rate = (value: number | null) => value === null ? '—' : `${value}%`;

export default function BlogPerformanceView(props: {
  project: Project; systemAdmin: boolean; onTracking: () => void;
}) {
  if (!props.systemAdmin) return <Empty title="Administrator access required" description="Only system administrators can review blog performance." />;
  return <AdminBlogPerformance key={props.project.id} {...props} />;
}

function AdminBlogPerformance({ project, onTracking }: { project: Project; onTracking: () => void }) {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const path = `${base}/blog-performance`;
  const agentsPath = `${base}/agents`;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [editing, setEditing] = useState<BlogPerformance>();
  const [generating, setGenerating] = useState<BlogPerformance>();
  const [selectedId, setSelectedId] = useState<string>();
  const result = useApi<BlogPerformancePage>(`${path}${query({ page, q: search, outcome })}`);
  const detail = useApi<{ post: AgentPost }>(selectedId ? `${agentsPath}/posts/${encodeURIComponent(selectedId)}` : null);
  const available = result.data?.generationAvailable === true;
  useEffect(() => {
    if (!detail.data || !['queued', 'generating'].includes(detail.data.post.status)) return;
    const timer = setInterval(() => void invalidateApiQueries(agentsPath), 3000);
    return () => clearInterval(timer);
  }, [detail.data, agentsPath]);
  useEffect(() => {
    if (result.data && page > 0 && page * 25 >= result.data.total) setPage(0);
  }, [result.data, page]);
  return <div className="blog-performance-screen">
    <header className="blog-review-heading">
      <div><div className="eyebrow"><ShieldCheck size={13} /> SYSTEM ADMIN</div><h1>Blog performance</h1><p>See which tracked articles earn AI citations, and what to write next for {reportExcerpt(project.name)}.</p></div>
      <div className="blog-review-buttons"><button className="button button-outline" onClick={onTracking}>Manage tracked URLs <ArrowUpRight size={14} /></button><button className="button button-outline" disabled={result.loading} onClick={() => void invalidateApiQueries(path)}><RefreshCw size={14} className={result.loading ? 'spinner' : ''} /> Refresh</button></div>
    </header>
    <div className="blog-review-method"><FileText size={19} /><p>Success means this URL was cited in an analyzed answer to its linked prompt in the last 30 days. Reviews use up to 90 days of evidence. This measures citation pickup; traffic and sales are not part of the score.</p></div>
    <div className="blog-review-toolbar">
      <label className="blog-review-search"><Search size={16} /><input aria-label="Search tracked blogs" type="search" placeholder="Search articles or prompts…" maxLength={200} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
      <select aria-label="Filter blog outcome" value={outcome} onChange={(event) => { setOutcome(event.target.value); setPage(0); }}><option value="all">All outcomes</option>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {result.data && <span>{result.data.total} tracked {result.data.total === 1 ? 'blog' : 'blogs'}</span>}
    </div>
    <ErrorNotice error={result.error} retry={() => void invalidateApiQueries(path)} />
    {!result.data && result.loading ? <Skeleton variant="cards" label="Reviewing tracked blogs…" /> : result.data?.items.length ? <>
      <div className="blog-review-list" aria-busy={result.loading}>{result.data.items.map((row) => <article className="blog-review-card" key={row.url.id}>
        <header><div><span className={`blog-outcome outcome-${row.outcome}`}>{outcomes[row.outcome]}</span><h2><a href={row.url.url} target="_blank" rel="noreferrer">{reportExcerpt(row.url.title)}<ArrowUpRight size={15} /></a></h2><p className="blog-review-url">{reportExcerpt(row.url.url)}</p></div><button className="button button-outline" onClick={() => setEditing(row)} disabled={Boolean(project.demo)}>{row.prompt ? 'Change prompt' : 'Link prompt'}</button></header>
        <div className="blog-review-prompt"><span>Prompt to answer</span><p>{reportExcerpt(row.prompt?.text || 'No prompt linked yet')}{row.prompt && !row.prompt.active && <strong> · Inactive</strong>}</p></div>
        <dl className="blog-review-metrics"><div><dt>Cited answers · 30 days</dt><dd>{row.current.citedAnswers} <small>/ {row.current.answers}</small></dd></div><div><dt>Citation rate</dt><dd>{rate(row.current.citationRate)}</dd></div><div><dt>Previous 30 days</dt><dd>{rate(row.previous.citationRate)}<small> · {row.previous.answers} answers</small></dd></div><div><dt>Last citation for prompt</dt><dd className="blog-review-date">{row.lastCitedAt ? formatDate(row.lastCitedAt, true) : 'No citation observed'}</dd></div></dl>
        <section className="blog-review-recommendation"><h3>{actions[row.action]}</h3><p>{reportExcerpt(row.reason)}</p>{row.changes.length > 0 && <ul>{row.changes.map((change) => <li key={change}>{reportExcerpt(change)}</li>)}</ul>}</section>
        <footer><span>Tracking since {formatDate(row.monitoringSince, true)} · {row.current.scanDays} scan {row.current.scanDays === 1 ? 'day' : 'days'} in the last 30 days</span>{(row.action === 'adjust' || row.action === 'create') && <button className="button button-primary" disabled={!available} onClick={() => setGenerating(row)}><Sparkles size={14} />{row.action === 'adjust' ? 'Prepare adjustment draft' : 'Prepare new article'}</button>}{row.action === 'resume' && <button className="button button-outline" onClick={onTracking}>Open Tracking</button>}</footer>
      </article>)}</div>
      <Pagination page={page} total={result.data.total} size={25} onChange={setPage} />
    </> : !result.error && <Empty title={search || outcome !== 'all' ? 'No blogs match these filters' : 'No tracked blogs yet'} description="Add a blog URL in Tracking, then link the saved prompt it answers here."><button className="button button-outline" onClick={onTracking}>Open Tracking</button></Empty>}
    {result.data && !available && !project.demo && <p className="blog-review-note">Draft generation requires OpenAI and Unsplash to be configured for this workspace.</p>}
    <details className="blog-review-rules"><summary>How recommendations are decided</summary><p>An uncited article needs at least 14 days of tracking and 3 analyzed answers across 2 days before an adjustment is recommended. A new article is recommended after at least 30 days and 6 recent answers across 3 days, with no citations in the review evidence. A citation-rate decline of more than half prompts an adjustment when both periods have enough evidence. Failed scans, repeated captures and answers to older prompt wording do not count. Resuming tracking starts a new review period.</p></details>
    {editing && result.data && <PromptLinkForm row={editing} prompts={result.data.prompts} path={path} onClose={() => setEditing(undefined)} />}
    {generating && <RefreshBlogForm row={generating} agentsPath={agentsPath} onClose={() => setGenerating(undefined)} onCreated={(post) => { setGenerating(undefined); setSelectedId(post.id); }} />}
    {selectedId && <Drawer title="Blog draft" onClose={() => setSelectedId(undefined)}><ErrorNotice error={detail.error} retry={() => void invalidateApiQueries(agentsPath)} />{detail.data ? <PostDetail key={detail.data.post.id} post={detail.data.post} owner={!project.demo} available={available} path={agentsPath} onUpdated={() => void invalidateApiQueries(agentsPath)} /> : !detail.error && <Skeleton variant="detail" label="Loading blog draft…" />}</Drawer>}
  </div>;
}

function PromptLinkForm({ row, prompts, path, onClose }: { row: BlogPerformance; prompts: BlogPerformancePage['prompts']; path: string; onClose: () => void }) {
  const [promptId, setPromptId] = useState(row.url.promptId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await request(`${path}/${row.url.id}`, { method: 'PATCH', body: JSON.stringify({ version: row.url.version, promptId: promptId || null }) });
      onClose();
    } catch (error) { setError(error as Error); } finally { setBusy(false); }
  }
  return <Drawer title="Link the article’s prompt" onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => void save(event)}><p className="blog-review-note">Choose the saved account prompt this article is intended to answer. Citation matches cannot establish that intent automatically.</p><ErrorNotice error={error} /><fieldset className="agent-generation-fields" disabled={busy}><label htmlFor="blog-target-prompt">Prompt to answer</label><select id="blog-target-prompt" value={promptId} onChange={(event) => setPromptId(event.target.value)}><option value="">No linked prompt</option>{prompts.filter((prompt) => prompt.active || prompt.id === row.url.promptId).map((prompt) => <option key={prompt.id} value={prompt.id} disabled={!prompt.active}>{reportExcerpt(prompt.text)}{!prompt.active ? ' (inactive)' : ''}</option>)}</select></fieldset><div className="agent-generation-actions"><button type="button" className="button button-outline" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save prompt link'}</button></div></form></Drawer>;
}

function RefreshBlogForm({ row, agentsPath, onClose, onCreated }: { row: BlogPerformance; agentsPath: string; onClose: () => void; onCreated: (post: AgentPost) => void }) {
  const [originalBody, setOriginalBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const adjust = row.action === 'adjust';
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (busy || !row.prompt || (row.action !== 'adjust' && row.action !== 'create')) return;
    setBusy(true); setError(undefined);
    try {
      const result = await idempotentPost<{ post: AgentPost }>(`${agentsPath}/posts`, {
        channel: 'blog', promptId: row.prompt.id,
        blogRefresh: { trackedUrlId: row.url.id, action: row.action, ...(originalBody.trim() ? { originalBody: originalBody.trim() } : {}) },
      });
      onCreated(result.post);
    } catch (error) { setError(error as Error); } finally { setBusy(false); }
  }
  return <Drawer title={adjust ? 'Prepare an adjustment draft' : 'Prepare a new article'} onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => void generate(event)}>
    <div className="blog-review-prompt"><span>Same saved prompt</span><p>{reportExcerpt(row.prompt?.text || '')}</p></div><p className="blog-review-note">{reportExcerpt(row.reason)}</p><ul className="blog-refresh-changes">{row.changes.map((change) => <li key={change}>{reportExcerpt(change)}</li>)}</ul>
    <ErrorNotice error={error} /><fieldset className="agent-generation-fields" disabled={busy}><label htmlFor="blog-current-article">Current article text {adjust ? '(required)' : '(optional)'}</label><textarea id="blog-current-article" required={adjust} maxLength={30000} rows={10} value={originalBody} onChange={(event) => setOriginalBody(event.target.value)} placeholder="Paste the current published article, including headings and links." /></fieldset>
    <p className="blog-review-note">The Blog agent will use fresh web research, the latest brandbook and this change brief. The result is saved in Agents for review and export. Generating a draft uses the configured content providers.</p><div className="agent-generation-actions"><button type="button" className="button button-outline" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || (adjust && !originalBody.trim())}>{busy ? <LoaderCircle size={14} className="spinner" /> : <Sparkles size={14} />}{busy ? 'Creating draft…' : 'Generate blog draft'}</button></div>
  </form></Drawer>;
}
