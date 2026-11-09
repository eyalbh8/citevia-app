import { useState } from 'react';
import { request, useApi } from './api';
import { ErrorNotice, Pagination } from './components';
import { Skeleton } from './Loading';

interface ReviewCandidate {
  id: string;
  version: number;
  title: string;
  brandName?: string;
  destination: string;
  channel: 'facebook' | 'instagram';
  scheduledAt: string;
  shareable: boolean;
  previousPlan: boolean;
}

interface ReviewLink {
  id: string;
  createdAt: string;
  expiresAt: string;
  publicationCount: number;
  publications: { id: string; version: number }[];
}

const pageSize = 100;

export default function SocialReviewLinks({ path, timezone, enabled, notify }: {
  path: string; timezone: string; enabled: boolean; notify: (message: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [created, setCreated] = useState<{ id: string; url: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const candidates = useApi<{ items: ReviewCandidate[]; total: number }>(
    `${path}/social/publications?clientReview=true&offset=${page * pageSize}`, revision);
  const endpoint = `${path}/social/review-links`;
  const links = useApi<{ items: ReviewLink[] }>(endpoint, revision);
  const sharedVersions = new Set(links.data?.items.flatMap(link => link.publications.map(post => `${post.id}/${post.version}`)));
  const posts = (candidates.data?.items ?? []).slice().sort((a, b) =>
    a.scheduledAt.localeCompare(b.scheduledAt) || (a.brandName ?? '').localeCompare(b.brandName ?? '') || a.channel.localeCompare(b.channel));
  const available = posts.filter(post => post.shareable);
  const selected = available.filter(post => selection[post.id] === post.version);
  const allSelected = available.length > 0 && available.length === selected.length;
  const when = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  function select(post: ReviewCandidate, checked: boolean) {
    setSelection(current => {
      const next = { ...current };
      if (checked) next[post.id] = post.version;
      else delete next[post.id];
      return next;
    });
  }
  async function create() {
    if (!enabled || busy || !selected.length || candidates.error) return;
    setBusy(true); setError(undefined);
    try {
      const link = await request<NonNullable<typeof created>>(endpoint, { method: 'POST',
        body: JSON.stringify({ publications: selected.map(({ id, version }) => ({ id, version })) }) });
      setCreated(link); setSelection({});
    } catch (failure) { setError(failure as Error); }
    finally { setBusy(false); setRevision(n => n + 1); }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await request(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (created?.id === id) setCreated(undefined);
      notify('Review link revoked.');
    } catch (failure) { setError(failure as Error); }
    finally { setBusy(false); setRevision(n => n + 1); }
  }
  async function copyLink() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); notify('Review link copied.'); }
    catch { setError(new Error('Select and copy the review link below.')); }
  }
  return <div className="social-review-links">
    <p>Choose the Facebook and Instagram publications to share. Anyone with the link can review these versions and authorize their scheduled publication.</p>
    <ErrorNotice error={error || candidates.error || links.error} retry={() => { setError(undefined); setRevision(n => n + 1); }} />
    {created && <section className="social-created-link" aria-label="New client review link">
      <label className="field"><span>Share this link with your client</span><input readOnly value={created.url} onFocus={event => event.target.select()} /></label>
      <small>Copy before closing. Expires {when(created.expiresAt)} ({timezone}).</small>
      <button type="button" className="button button-primary" onClick={copyLink}>Copy review link</button>
    </section>}
    <h3>Awaiting approval</h3>
    {candidates.loading && !candidates.data && <Skeleton variant="table" rows={3} label="Loading posts awaiting approval…" />}
    {candidates.data?.total === 0 && <p>No Facebook or Instagram publications are awaiting approval.</p>}
    {posts.length > 0 && <>
      <label className="social-check"><input type="checkbox" checked={allSelected} disabled={!enabled || busy || !available.length}
        onChange={event => setSelection(event.target.checked ? Object.fromEntries(available.map(post => [post.id, post.version])) : {})} />
        <strong>Select all eligible on this page ({available.length})</strong></label>
      <ul className="social-review-candidates">{posts.map(post => <li key={post.id}><label className="social-check">
        <input type="checkbox" checked={post.shareable && selection[post.id] === post.version} disabled={!enabled || busy || !post.shareable}
          onChange={event => select(post, event.target.checked)} />
        <span><strong>{post.title}</strong><small>{[post.brandName, post.channel === 'facebook' ? 'Facebook' : 'Instagram', post.destination].filter(Boolean).join(' · ')}</small>
          <small>{when(post.scheduledAt)} ({timezone})</small>
          {sharedVersions.has(`${post.id}/${post.version}`) && <small>Included in an active client review link</small>}
          {!post.shareable && <small>{post.previousPlan ? 'From a previous brand plan. Share the current draft.' : 'Check the publishing time, destination and media in the queue.'}</small>}</span>
      </label></li>)}</ul>
      <button type="button" className="button button-primary" onClick={create} disabled={!enabled || busy || !selected.length || Boolean(candidates.error)}>
        Create review link ({selected.length})
      </button>
    </>}
    {!enabled && <p className="social-help">Enable automation to request approval.</p>}
    {(candidates.data?.total ?? 0) > pageSize && <Pagination page={page} size={pageSize} total={candidates.data!.total} disabled={busy}
      onChange={next => { setSelection({}); setPage(next); }} />}
    {Boolean(links.data?.items.length) && <section><h3>Active links</h3>
      <ul className="social-review-candidates">{links.data!.items.map(link => <li className="social-review-link-row" key={link.id}>
        <div><strong>{link.publicationCount} destination publications</strong><small>Created {when(link.createdAt)} · Expires {when(link.expiresAt)} ({timezone})</small></div>
        <button className="button button-outline" type="button" disabled={busy} onClick={() => revoke(link.id)}>Revoke</button>
      </li>)}</ul></section>}
  </div>;
}
