import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Save, Trash2, Upload } from 'lucide-react';
import { request, useApi } from './api';
import { ErrorNotice, safeUrl } from './components';
import { Skeleton } from './Loading';
import type { SocialPublicationPreview } from './SocialAutomationSettings';
import SocialPhotoCredit from './SocialPhotoCredit';

export function socialLocalDateTime(value: string, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Resolve a wall-clock choice in the project timezone without using the browser's timezone. */
export function socialPublishingInstant(value: string, timezone: string, original?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a publishing date and time.');
  if (original && socialLocalDateTime(original, timezone) === value) return original;
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) throw new Error('Choose a valid publishing date and time.');
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3600000;
    offsets.add(Date.parse(`${socialLocalDateTime(new Date(sample).toISOString(), timezone)}:00Z`) - sample);
  }
  const matches = [...offsets].map(offset => wall - offset)
    .filter(candidate => socialLocalDateTime(new Date(candidate).toISOString(), timezone) === value).sort((a, b) => a - b);
  if (!matches.length) throw new Error('This local time does not occur because the clocks change. Choose another publishing time.');
  return new Date(matches[0]).toISOString();
}

const tags = (value: string) => value.trim().split(/\s+/).filter(Boolean).map(tag => tag.startsWith('#') ? tag : `#${tag}`);
type ReviewMedia = NonNullable<SocialPublicationPreview['media']>;
// Private preview URLs expire independently of the immutable approved asset identity.
const mediaIdentity = (media: ReviewMedia) => JSON.stringify(media.map(asset => ({
  id: asset.id ?? null, url: asset.id ? null : asset.url, type: asset.type, mimeType: asset.mimeType,
})));
function refreshedMedia(current: ReviewMedia, incoming: ReviewMedia): ReviewMedia {
  return current.map(asset => {
    const refreshed = asset.id && incoming.find(next => next.id === asset.id && next.type === asset.type && next.mimeType === asset.mimeType);
    return refreshed && refreshed.url !== asset.url ? { ...asset, url: refreshed.url } : asset;
  });
}
const mediaPreview = (media: NonNullable<SocialPublicationPreview['media']>[number], index: number) => {
  const url = safeUrl(media.url);
  return !url ? null : <>{media.type === 'video'
    ? <video src={url} controls preload="metadata" aria-label="Post video preview" />
    : <img src={url} alt={`Post image ${index + 1}`} />}<SocialPhotoCredit photos={media.attribution} /></>;
};

export default function SocialPublicationReview({ post, path, owner, enabled, timezone, onSaved, notify }: {
  post: SocialPublicationPreview; path: string; owner: boolean; enabled: boolean; timezone: string;
  onSaved: () => void; notify: (message: string) => void;
}) {
  const [savedPost, setSavedPost] = useState(post);
  const [title, setTitle] = useState(post.content?.title || '');
  const [body, setBody] = useState(post.content?.body || '');
  const [hashtags, setHashtags] = useState(post.content?.hashtags.join(' ') || '');
  const [media, setMedia] = useState(post.media || []);
  const [scheduledAt, setScheduledAt] = useState(() => socialLocalDateTime(post.scheduledAt, timezone));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<Error>();
  useEffect(() => {
    // A refresh may renew signed URLs without changing the publication version.
    // Only replace URLs by stable ID so local edits, removals and ordering survive.
    if (post.version !== savedPost.version) return;
    setSavedPost(current => ({ ...current, editable: post.editable, media: refreshedMedia(current.media || [], post.media || []) }));
    setMedia(current => refreshedMedia(current, post.media || []));
  }, [post, savedPost.version]);
  const editable = owner && post.editable !== false && ['review_required', 'scheduled'].includes(savedPost.status);
  const content = { title, body, hashtags: tags(hashtags) };
  const dirty = title !== (savedPost.content?.title || '') || body !== (savedPost.content?.body || '') ||
    JSON.stringify(content.hashtags) !== JSON.stringify(savedPost.content?.hashtags || []) || mediaIdentity(media) !== mediaIdentity(savedPost.media || []) ||
    scheduledAt !== socialLocalDateTime(savedPost.scheduledAt, timezone);
  const isVideo = post.channel === 'tiktok';
  const maximumMedia = post.channel === 'instagram' ? 10 : 1;
  const busy = saving || uploading;
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editable || busy || !dirty) return;
    setError(undefined); setSaving(true);
    try {
      const instant = socialPublishingInstant(scheduledAt, timezone, savedPost.scheduledAt);
      if (Date.parse(instant) <= Date.now()) throw new Error('Choose a future publishing time before saving.');
      const updated = await request<SocialPublicationPreview>(`${path}/social/publications/${post.id}`, {
        method: 'PATCH', body: JSON.stringify({ version: savedPost.version, content, media, scheduledAt: instant }),
      });
      setSavedPost(updated); setTitle(updated.content?.title || ''); setBody(updated.content?.body || '');
      setHashtags(updated.content?.hashtags.join(' ') || ''); setMedia(updated.media || []);
      setScheduledAt(socialLocalDateTime(updated.scheduledAt, timezone));
      notify('Changes saved. Review this version before approving publishing.'); onSaved();
    } catch (failure) { setError(failure as Error); }
    finally { setSaving(false); }
  }
  async function upload(file: File | undefined, replaceIndex?: number) {
    if (!file || !editable || busy || dirty) return;
    setUploading(true); setError(undefined);
    try {
      const allowed = isVideo ? ['video/mp4'] : ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowed.includes(file.type)) throw new Error(isVideo ? 'Choose an MP4 video.' : 'Choose a JPG, PNG or WebP image.');
      if (!file.size || file.size > (isVideo ? 100 : 10) * 1024 * 1024) throw new Error(`Choose a ${isVideo ? 'video smaller than 100 MB' : 'image smaller than 10 MB'}.`);
      const endpoint = `${path}/social/publications/${post.id}/media`;
      const upload = await request<{ uploadId: string; url: string; fields: Record<string, string> }>(`${endpoint}/start`, {
        method: 'POST', body: JSON.stringify({ version: savedPost.version, filename: file.name, mimeType: file.type, size: file.size,
          ...(replaceIndex !== undefined ? { replaceIndex } : {}) }),
      });
      const payload = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) payload.append(key, value);
      payload.append('file', file);
      // The signed storage request carries no Citevia token, cookies or JSON header.
      const result = await fetch(upload.url, { method: 'POST', body: payload, credentials: 'omit', redirect: 'error' });
      if (!result.ok) throw new Error('The media upload failed. Try uploading the file again.');
      const updated = await request<SocialPublicationPreview>(`${endpoint}/complete`, {
        method: 'POST', body: JSON.stringify({ version: savedPost.version, uploadId: upload.uploadId }),
      });
      setSavedPost(updated); setMedia(updated.media || []);
      notify('Media updated. Review the new version before approving publishing.'); onSaved();
    } catch (failure) { setError(failure as Error); }
    finally { setUploading(false); }
  }
  function move(index: number, direction: -1 | 1) {
    const next = [...media]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; setMedia(next);
  }
  const uploadControl = (label: string, replaceIndex?: number) => <label className={`button button-outline social-upload-button ${!editable || busy || dirty ? 'is-disabled' : ''}`}>
    <Upload size={14} aria-hidden="true" />{label}
    <input type="file" aria-label={label} accept={isVideo ? 'video/mp4' : 'image/jpeg,image/png,image/webp'} disabled={!editable || busy || dirty}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file, replaceIndex); }} />
  </label>;
  return <div className="social-post-review">
    {savedPost.status === 'scheduled' && <p className="social-approved-note">Approved for scheduled publishing. Any saved edit or media replacement removes approval until you review it again.</p>}
    <form className="social-post-editor" aria-label="Edit prepared post" onSubmit={save}>
      <fieldset disabled={!editable || busy}>
        <label className="field"><span>Post title</span><input aria-label="Post title" value={title} onChange={event => setTitle(event.target.value)} maxLength={300} required /></label>
        <label className="field"><span>Post text</span><textarea aria-label="Post text" value={body} onChange={event => setBody(event.target.value)} rows={7} required /></label>
        <label className="field"><span>Hashtags</span><input aria-label="Post hashtags" value={hashtags} onChange={event => setHashtags(event.target.value)} placeholder="#YourBrand #Topic" /></label>
        <label className="field"><span>Publishing date and time · {timezone}</span><input type="datetime-local" aria-label="Post publishing date and time" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} required /></label>
        <p className="social-help">The time is in {timezone}. If clocks repeat an hour, a new time uses its first occurrence. Publishing starts only after approval.</p>
        <div className="social-editor-media-heading"><h3>{isVideo ? 'Video' : post.channel === 'instagram' ? 'Images and carousel order' : 'Image'}</h3><span>{media.length} / {maximumMedia}</span></div>
        <div className="social-preview-media">{media.map((asset, index) => <div className="social-editor-media" key={`${asset.url}-${index}`}>
          {mediaPreview(asset, index)}
          <div className="social-media-actions">
            <span>{isVideo ? 'Video' : `Image ${index + 1}`}</span>
            {uploadControl(`Replace ${isVideo ? 'video' : `image ${index + 1}`}`, index)}
            {!isVideo && media.length > 1 && <>
              <button type="button" className="icon-button" aria-label={`Move image ${index + 1} earlier`} disabled={index === 0 || !editable || busy} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
              <button type="button" className="icon-button" aria-label={`Move image ${index + 1} later`} disabled={index === media.length - 1 || !editable || busy} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
            </>}
            <button type="button" className="icon-button" aria-label={`Remove ${isVideo ? 'video' : `image ${index + 1}`}`} onClick={() => setMedia(media.filter((_, position) => position !== index))}><Trash2 size={16} /></button>
          </div>
        </div>)}</div>
        {media.length < maximumMedia && uploadControl(isVideo ? 'Upload video' : media.length ? 'Add carousel image' : 'Upload image')}
        <p className="social-help">{isVideo ? 'Upload an MP4 video up to 100 MB to replace the generated video.' : 'Upload a JPG, PNG or WebP image up to 10 MB to replace generated artwork.'} {dirty ? 'Save your changes before uploading media.' : 'Uploading media saves it immediately and requires a new approval.'}</p>
        <button type="submit" className="button button-outline" disabled={!editable || busy || !dirty}><Save size={14} />{saving ? 'Saving…' : 'Save post changes'}</button>
      </fieldset>
      {uploading && <p role="status">Uploading media…</p>}
      {!owner && <p className="social-help">Only a project owner can edit and approve this post.</p>}
      <ErrorNotice error={error} />
    </form>
    {savedPost.status === 'review_required' && <PublicationApproval key={`${savedPost.id}-${savedPost.version}-${dirty}`} post={savedPost} path={path}
      owner={owner && savedPost.editable !== false} enabled={enabled} blocked={dirty || busy} onSaved={onSaved} notify={notify} />}
  </div>;
}

interface TikTokOptions {
  creator: { privacyLevels: string[]; canPostMore: boolean; interactions: { allowComment: boolean; allowDuet: boolean; allowStitch: boolean } };
  music: { id: string; name: string; artist: string; previewUrl?: string }[];
}
function PublicationApproval({ post, path, owner, enabled, blocked, onSaved, notify }: {
  post: SocialPublicationPreview; path: string; owner: boolean; enabled: boolean; blocked: boolean;
  onSaved: () => void; notify: (message: string) => void;
}) {
  const tiktok = post.channel === 'tiktok';
  const options = useApi<TikTokOptions>(tiktok ? `${path}/social/publications/${post.id}/tiktok-options` : null);
  const [privacyLevel, setPrivacyLevel] = useState('');
  const [musicSoundId, setMusicSoundId] = useState('');
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [expressConsentGiven, setExpressConsentGiven] = useState(false);
  const [interactions, setInteractions] = useState({ allowComment: false, allowDuet: false, allowStitch: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const track = options.data?.music.find(item => item.id === musicSoundId);
  const future = Date.parse(post.scheduledAt) > Date.now();
  const interactionsAllowed = options.data && (Object.keys(interactions) as (keyof typeof interactions)[]).every(name => !interactions[name] || options.data!.creator.interactions[name]);
  const ready = owner && enabled && !blocked && future && previewConfirmed && expressConsentGiven && Boolean(post.media?.length) &&
    (!tiktok || (options.data?.creator.canPostMore && options.data.creator.privacyLevels.includes(privacyLevel) && interactionsAllowed && track));
  async function approve(event: FormEvent) {
    event.preventDefault(); if (!ready || saving) return; setSaving(true); setError(undefined);
    try {
      await request(`${path}/social/publications/${post.id}/approve`, { method: 'POST', body: JSON.stringify({ version: post.version,
        previewConfirmed, expressConsentGiven, ...(tiktok ? { privacyLevel, musicSoundId, ...interactions } : {}) }) });
      notify('Post approved. It will publish at the scheduled time.'); onSaved();
    } catch (failure) { setError(failure as Error); } finally { setSaving(false); }
  }
  return <form className="social-tiktok-review" onSubmit={approve} aria-label={tiktok ? 'Review TikTok publication' : 'Approve scheduled publication'}>
    <h3>Approve scheduled publishing</h3>
    <ErrorNotice error={error || options.error} />
    {blocked && <p className="social-help">Save your changes, then review the saved text and media before approving.</p>}
    {!enabled && <p className="social-help">Automation is paused. Publishing approval is unavailable.</p>}
    {!future && <p className="social-readiness">This publishing time has passed. Choose and save a future date before approving.</p>}
    {tiktok && options.loading && !options.data && <Skeleton variant="form" label="Loading TikTok publishing choices…" />}
    <fieldset disabled={!owner || !enabled || blocked || saving || !future || (tiktok && !options.data?.creator.canPostMore)}>
      {tiktok && options.data && <>
        {!options.data.creator.canPostMore && <p className="social-readiness">TikTok is not accepting more posts for this account right now.</p>}
        <label className="field"><span>Who can see this post?</span><select value={privacyLevel} onChange={event => setPrivacyLevel(event.target.value)} required><option value="">Choose privacy</option>
          {options.data.creator.privacyLevels.map(level => <option key={level} value={level}>{level.replace(/_/g, ' ').toLowerCase()}</option>)}</select></label>
        <label className="field"><span>Music</span><select value={musicSoundId} onChange={event => setMusicSoundId(event.target.value)} required><option value="">Choose a licensed track</option>
          {options.data.music.map(item => <option key={item.id} value={item.id}>{item.name}{item.artist ? ` — ${item.artist}` : ''}</option>)}</select></label>
        {!options.data.music.length && <p className="social-readiness">No licensed tracks are available. This post will stay in review.</p>}
        {track?.previewUrl && safeUrl(track.previewUrl) && <audio src={safeUrl(track.previewUrl)} controls preload="none" aria-label="Music preview" />}
        <div className="social-tiktok-interactions">{(['allowComment', 'allowDuet', 'allowStitch'] as const).map(name => <label className="social-check" key={name}>
          <input type="checkbox" checked={interactions[name]} disabled={!options.data!.creator.interactions[name]} onChange={event => setInteractions({ ...interactions, [name]: event.target.checked })} />
          <span>{{ allowComment: 'Allow comments', allowDuet: 'Allow Duet', allowStitch: 'Allow Stitch' }[name]}</span></label>)}</div>
      </>}
      <label className="social-check"><input type="checkbox" checked={previewConfirmed} onChange={event => setPreviewConfirmed(event.target.checked)} /><span>I reviewed the saved text and {tiktok ? 'video' : 'images'} above.</span></label>
      <label className="social-check"><input type="checkbox" checked={expressConsentGiven} onChange={event => setExpressConsentGiven(event.target.checked)} /><span>I authorize Citevia to publish this version to {post.destination} at the scheduled time.</span></label>
      <button type="submit" className="button button-primary" disabled={!ready || saving}>{saving ? 'Scheduling…' : 'Approve and schedule'}</button>
    </fieldset>
  </form>;
}
