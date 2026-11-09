import { useEffect, useState } from 'react';
import type { SharedSocialCreative, SharedSocialReview } from '@citevia/core';
import { Badge, ErrorNotice, Logo } from './components';
import SocialPhotoCredit from './SocialPhotoCredit';
import './shared-social-review.css';

const baseUrl = String(import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
type Publication = SharedSocialCreative['publications'][number];
type Grant = { projectId: string; token: string };

async function reviewRequest<T>(grant: Grant, decision?: Pick<Publication, 'id' | 'version'>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl}/social-reviews/${grant.projectId}${decision ? '/approve' : ''}`, {
    method: decision ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: { Authorization: `Bearer ${grant.token}`, ...(decision ? { 'Content-Type': 'application/json' } : {}) },
    ...(decision ? { body: JSON.stringify({ ...decision, previewConfirmed: true, expressConsentGiven: true }) } : {}),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.error?.message || 'The review request could not be completed.');
  }
  return response.json();
}

function ReviewCard({ creative, timezone, grant }: { creative: SharedSocialCreative; timezone: string; grant: Grant }) {
  const [excluded, setExcluded] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Publication['status']>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pending = creative.publications.filter(p => (outcomes[p.id] ?? p.status) === 'review_required');
  const selected = pending.filter(p => !excluded.includes(p.id) && Date.parse(p.scheduledAt) > Date.now());
  const mediaReady = !!creative.media?.length && creative.media.every(asset => loaded[asset.url]);
  async function approve() {
    if (busy || !confirmed || !selected.length || !mediaReady) return;
    setBusy(true); setErrors({});
    await Promise.all(selected.map(async ({ id, version }) => {
      try {
        const result = await reviewRequest<{ status: Publication['status'] }>(grant, { id, version });
        setOutcomes(previous => ({ ...previous, [id]: result.status }));
      } catch (failure) {
        setErrors(previous => ({ ...previous, [id]: (failure as Error).message }));
      }
    }));
    setConfirmed(false); setBusy(false);
  }
  return <article className="shared-creative">
    <header><span>{creative.brandName}</span><h2>{creative.content?.title ?? 'Publication changed'}</h2></header>
    {creative.content && <div className="shared-content">
      <div className="shared-images">{creative.media?.map((asset, i) => <figure key={asset.url}>
        <img src={asset.url} alt={asset.attribution?.[0]?.alt || `Post image ${i + 1}`} referrerPolicy="no-referrer"
          onLoad={() => setLoaded(current => ({ ...current, [asset.url]: true }))}
          onError={() => setLoaded(current => ({ ...current, [asset.url]: false }))} />
        {loaded[asset.url] === false && <p role="alert">Image unavailable. Refresh the review to reload it.</p>}
        <SocialPhotoCredit photos={asset.attribution} />
      </figure>)}</div>
      <div><p className="shared-caption">{creative.content.body}</p><p>{creative.content.hashtags.join(' ')}</p></div>
    </div>}
    <ul className="shared-destinations">{creative.publications.map(p => {
      const status = outcomes[p.id] ?? p.status;
      const pastDue = status === 'review_required' && Date.parse(p.scheduledAt) <= Date.now();
      const when = new Date(p.scheduledAt).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      return <li key={p.id}><label>{status === 'review_required' && <input type="checkbox" checked={!pastDue && !excluded.includes(p.id)} disabled={busy || pastDue}
        onChange={e => { setConfirmed(false); setExcluded(e.target.checked ? excluded.filter(id => id !== p.id) : [...excluded, p.id]); }} />}
        <span><strong>{p.channel === 'facebook' ? 'Facebook' : 'Instagram'} · {p.destination}</strong><br/>{when} ({timezone})</span>
      </label><Badge value={status} label={status === 'review_required' ? 'Awaiting approval' : undefined} />
      {pastDue && <p>The publishing time has passed. Ask the owner to reschedule and share a new link.</p>}
      {errors[p.id] && <p role="alert">{errors[p.id]}</p>}</li>;
    })}</ul>
    {!creative.content && <p>Ask the owner for a link to the latest version.</p>}
    {!!pending.length && <div className="shared-decision"><label><input type="checkbox" checked={confirmed}
      disabled={!selected.length || busy || !mediaReady} onChange={e => setConfirmed(e.target.checked)} />
      I reviewed this caption and the images and authorize publication to the selected accounts at the listed times.</label>
      <button className="button button-primary" disabled={!confirmed || !selected.length || busy || !mediaReady} onClick={approve}>
      {busy ? 'Scheduling…' : `Approve and schedule (${selected.length})`}</button></div>}
  </article>;
}

export default function SharedSocialReviewPage({ hash }: { hash: string }) {
  const [, projectId, token] = /^#social-review\/([A-Za-z0-9_-]{1,804})\/([a-f0-9]{64})$/.exec(hash) ?? [];
  const [batch, setBatch] = useState<SharedSocialReview>();
  const [error, setError] = useState<Error>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    document.title = 'Social post review · Citevia';
    if (!projectId || !token) { setError(new Error('This review link is invalid. Ask the owner for a new link.')); return; }
    const controller = new AbortController();
    setBatch(undefined); setError(undefined);
    void reviewRequest<SharedSocialReview>({ projectId, token }, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setBatch(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [projectId, token, revision]);
  return <main className="shared-social-page"><Logo/><header><h1>Social post review</h1>
    {batch && <><p>Review each caption, image, destination and time. Approving authorizes Citevia to publish to the selected accounts at the listed times.</p>
      <p>This link expires {new Date(batch.expiresAt).toLocaleString(undefined, { timeZone: batch.timezone })} ({batch.timezone}).</p>
      <button className="button button-outline" onClick={() => setRevision(n => n + 1)}>Refresh review</button></>}
  </header>
    <ErrorNotice error={error} retry={token ? () => setRevision(n => n + 1) : undefined} />
    {!batch && !error && <p role="status">Loading posts…</p>}
    {batch?.creatives.map(creative => <ReviewCard key={creative.id} creative={creative} timezone={batch.timezone} grant={{ projectId, token }} />)}
  </main>;
}
