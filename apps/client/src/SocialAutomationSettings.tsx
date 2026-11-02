import { useEffect, useId, useState, type FormEvent } from 'react';
import { CalendarClock, Check, FileText, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { MAX_SOCIAL_AUTOMATION_SLOTS, SOCIAL_CHANNELS, socialAutomationInputSchema,
  type Project, type SocialAutomationInput, type SocialAutomationSettings as AutomationSettings, type SocialChannel,
  type SocialDestination, type SocialPublication } from '@citevia/core';
import { request, useApi } from './api';
import { Badge, Drawer, ErrorNotice, Pagination, safeUrl } from './components';
import { Skeleton } from './Loading';
import './social-automation.css';

type Connection = Omit<SocialDestination, 'profileId'>;
export interface SocialSettingsResponse {
  settings: AutomationSettings;
  version: number;
  connections: Connection[];
  destinationOptions?: Project['socialDestinationOptions'];
  publishingAvailable: boolean;
  generationAvailable: boolean;
  blogAvailable: boolean;
  videoAvailable?: boolean;
}
export interface SocialPublicationPreview {
  id: string;
  prompt: string;
  promptId: string;
  channel: SocialChannel | 'blog';
  destination: string;
  status: SocialPublication['status'];
  createdAt: string;
  scheduledAt: string;
  updatedAt: string;
  version: number;
  content?: SocialPublication['content'];
  media?: SocialPublication['media'];
  draftPostId?: string;
  publishedUrl?: string;
  error?: SocialPublication['error'];
}
const labels: Record<SocialChannel | 'blog', string> = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', pinterest: 'Pinterest', reddit: 'Reddit', tiktok: 'TikTok', blog: 'Blog draft',
};
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const statusLabels: Record<SocialPublication['status'], string> = {
  queued: 'Queued', generating: 'Creating', review_required: 'Review needed', publishing: 'Publishing', published: 'Published',
  draft_created: 'Draft created', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Publication unconfirmed',
};
const editableSettings = (settings: AutomationSettings): SocialAutomationInput => ({
  enabled: settings.enabled, createBlogDrafts: settings.createBlogDrafts, timezone: settings.timezone, slots: settings.slots.map(slot => ({ ...slot })),
});
const connected = (connection: Connection) => connection.active && !connection.requiresReconnect;
const timestamp = (value: string, timezone?: string) => {
  try { return new Date(value).toLocaleString('en', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return value; }
};

export default function SocialAutomationSettings({ project, path, onSaved, notify }: {
  project: Project; path: string; onSaved: () => void; notify: (message: string) => void;
}) {
  const [revision, refresh] = useState(0);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const state = useApi<SocialSettingsResponse>(`${path}/social`, project.version + revision);
  const history = useApi<{ items: SocialPublicationPreview[]; total: number }>(`${path}/social/publications?offset=${page * 20}`, revision);
  const detail = useApi<SocialPublicationPreview>(selectedId ? `${path}/social/publications/${encodeURIComponent(selectedId)}` : null, revision);
  const owner = project.role === 'owner' && !project.demo;
  const pending = history.data?.items.some(post => ['queued', 'generating', 'publishing'].includes(post.status));
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => refresh(value => value + 1), 10000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const saved = () => { refresh(value => value + 1); onSaved(); };
  const post = detail.data?.id === selectedId ? detail.data : undefined;
  return <section className="card social-automation" aria-labelledby="social-automation-title">
    <div className="card-header">
      <div><h2 id="social-automation-title" className="card-title">Automated social media</h2>
        <p className="card-description">Turn your prompts into posts for your connected accounts, on your schedule.</p></div>
      <CalendarClock size={22} aria-hidden="true" />
    </div>
    <div className="card-content">
      <ErrorNotice error={state.error} retry={() => refresh(value => value + 1)} />
      {state.loading && !state.data && <Skeleton variant="form" label="Loading social automation settings…" />}
      {state.data?.settings && <>
        <AutomationForm key={`${project.id}-${state.data.settings.revision}`} data={state.data} path={path} owner={owner} onSaved={saved} notify={notify} />
        <div className="social-connected-heading"><h3>Publishing destinations</h3><a className="button button-outline" href="#integrations">Manage connections</a></div>
        <p className="card-description">Each scheduled time creates a post answering one active prompt for every ready account. New connections join the next scheduled time.</p>
        <div className="social-connections">
          {SOCIAL_CHANNELS.map(channel => {
            const accounts = state.data!.connections.filter(connection => connection.channel === channel);
            const ready = accounts.some(connected);
            const needsDestination = accounts.some(account => connected(account) &&
              ((channel === 'pinterest' && !state.data!.destinationOptions?.[account.id]?.boardId) ||
               (channel === 'reddit' && !state.data!.destinationOptions?.[account.id]?.subreddit)));
            const label = !state.data!.publishingAvailable ? 'Setup needed' : !accounts.length ? 'Not connected' : !ready ? 'Reconnect' :
              needsDestination ? 'Choose destination' : !state.data!.generationAvailable ? 'Generation setup needed' :
              channel === 'tiktok' && state.data!.videoAvailable === false ? 'Video setup needed' : channel === 'tiktok' ? 'Review each post' : 'Ready';
            return <div key={channel} className={`social-connection ${ready ? 'is-connected' : ''}`}>
              <div><strong>{labels[channel]}</strong><span>{accounts.map(account => account.username).join(', ') || 'Connect an account to include it'}</span></div>
              <span className="social-connection-status">{ready && <Check size={13} aria-hidden="true" />}{label}</span>
            </div>;
          })}
        </div>
        {state.data.connections.filter(connection => connected(connection) && ['pinterest', 'reddit'].includes(connection.channel)).map(connection =>
          <DestinationForm key={`${connection.id}-${JSON.stringify(state.data!.destinationOptions?.[connection.id] || {})}`}
            connection={connection} value={state.data!.destinationOptions?.[connection.id]} version={state.data!.version}
            path={path} owner={owner} onSaved={saved} notify={notify} />)}
        <p className="social-help">TikTok posts are prepared on schedule. Review the video, choose music and privacy, and approve each post before it is published.</p>
        {state.data.videoAvailable === false && state.data.connections.some(connection => connection.channel === 'tiktok' && connected(connection)) &&
          <p className="social-readiness">TikTok posts will start once video creation is configured. Other connected accounts and blog drafts can still run.</p>}
      </>}
      <div className="social-connected-heading"><h3>Recent automation</h3><button type="button" className="button button-outline" onClick={() => refresh(value => value + 1)}><RefreshCw size={14} />Refresh</button></div>
      <ErrorNotice error={history.error} retry={() => refresh(value => value + 1)} />
      {history.loading && !history.data && <Skeleton variant="table" rows={3} label="Loading automated posts…" />}
      {history.data && !history.data.items.length && <p className="social-empty">Your scheduled posts and blog drafts will appear here. Choose a schedule and save to get started.</p>}
      <div className="social-history">
        {history.data?.items.map(item => <button type="button" className="social-history-row" key={item.id} onClick={() => setSelectedId(item.id)}>
          <div><span className="social-history-channel">{labels[item.channel]} · {item.destination}</span><strong>{item.content?.title || item.prompt}</strong>
            <span>{timestamp(item.scheduledAt, state.data?.settings?.timezone)}</span></div>
          <Badge value={item.status === 'draft_created' || item.status === 'published' ? 'completed' : item.status === 'review_required' ? 'partial' : item.status} label={statusLabels[item.status]} />
        </button>)}
      </div>
      {(history.data?.total || 0) > 20 && <Pagination page={page} total={history.data!.total} size={20} onChange={setPage} />}
    </div>
    {selectedId && <Drawer title={post ? `${labels[post.channel]} preview` : 'Post preview'} onClose={() => setSelectedId(undefined)}>
      <ErrorNotice error={detail.error} retry={() => refresh(value => value + 1)} />
      {!post && !detail.error && <Skeleton variant="form" label="Loading post preview…" />}
      {post && <div className="social-preview">
        <Badge value={post.status} label={statusLabels[post.status]} />
        <p className="card-description">Answering: {post.prompt}</p>
        <h3>{post.content?.title || 'Post in progress'}</h3>
        <div className="social-preview-media">{post.media?.map((media, index) => {
          const url = safeUrl(media.url); if (!url) return null;
          return media.type === 'video' ? <video key={url} src={url} controls preload="metadata" aria-label="Generated post video" /> : <img key={url} src={url} alt={`Generated post image ${index + 1}`} />;
        })}</div>
        <p className="social-preview-copy">{post.content?.body}</p>
        {Boolean(post.content?.hashtags.length) && <p className="social-preview-tags">{post.content!.hashtags.join(' ')}</p>}
        <ErrorNotice error={post.error?.message} />
        {post.status === 'uncertain' && <p className="social-readiness">Publication could not be confirmed. Check the connected account before creating another post with this content.</p>}
        {post.channel === 'blog' && <div className="social-blog-note"><FileText size={19} /><div><strong>Blog draft only</strong><p>This automation creates the article in Agents. It does not publish to your website.</p><a href="#agents" className="button button-outline" onClick={() => setSelectedId(undefined)}>Open blog drafts</a></div></div>}
        {post.publishedUrl && safeUrl(post.publishedUrl) && <a href={safeUrl(post.publishedUrl)} className="button button-outline" target="_blank" rel="noreferrer noopener">View published post</a>}
        {post.channel === 'tiktok' && post.status === 'review_required' && <TikTokApproval key={`${post.id}-${post.version}`} post={post} path={path} owner={owner}
          enabled={state.data?.settings.enabled === true} onSaved={saved} notify={notify} />}
      </div>}
    </Drawer>}
  </section>;
}

function AutomationForm({ data, path, owner, onSaved, notify }: {
  data: SocialSettingsResponse; path: string; owner: boolean; onSaved: () => void; notify: (message: string) => void;
}) {
  const [form, setForm] = useState(() => editableSettings(data.settings));
  const [baseline, setBaseline] = useState(() => editableSettings(data.settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const uniqueId = useId();
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  function addSlot() {
    const choices = Array.from({ length: 7 * 24 }, (_, index) => ({ dayOfWeek: (Math.floor(index / 24) + 1) % 7, time: `${String((index % 24 + 9) % 24).padStart(2, '0')}:00` }));
    const next = choices.find(choice => !form.slots.some(slot => slot.dayOfWeek === choice.dayOfWeek && slot.time === choice.time))!;
    setForm({ ...form, slots: [...form.slots, { id: `slot_${crypto.randomUUID()}`, ...next }] });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!owner || saving) return;
    setError(undefined);
    const parsed = socialAutomationInputSchema.safeParse(form);
    if (!parsed.success) { setError(new Error(parsed.error.issues[0].message)); return; }
    if (form.enabled && !data.generationAvailable) { setError(new Error('Content generation is not configured yet.')); return; }
    if (form.enabled && form.createBlogDrafts && !data.blogAvailable) { setError(new Error('Blog draft generation is not configured yet.')); return; }
    if (form.enabled && !form.createBlogDrafts && !data.connections.some(connected)) { setError(new Error('Connect a social account or include blog drafts before enabling automation.')); return; }
    setSaving(true);
    try {
      const result = await request<{ settings: AutomationSettings; version: number }>(`${path}/social/settings`, {
        method: 'PATCH', body: JSON.stringify({ version: data.version, settings: parsed.data }),
      });
      const updated = editableSettings(result.settings); setForm(updated); setBaseline(updated);
      notify(updated.enabled ? 'Automation schedule saved.' : 'Automation paused. Your posts and drafts are preserved.'); onSaved();
    } catch (failure) { setError(failure as Error); onSaved(); }
    finally { setSaving(false); }
  }
  return <form className="social-schedule-form" onSubmit={save} aria-label="Social automation settings">
    <fieldset disabled={!owner || saving}>
      <div className="social-toggle-row"><div><strong id={`${uniqueId}-toggle`}>Automated social media</strong><p className="card-description">{form.enabled ? 'On' : 'Paused'}{dirty ? ' · Unsaved changes' : ''}</p></div>
        <button type="button" className="scanning-switch" role="switch" aria-checked={form.enabled} aria-labelledby={`${uniqueId}-toggle`}
          disabled={!owner || saving} onClick={() => setForm({ ...form, enabled: !form.enabled })}><span /></button></div>
      <p className="social-help">When paused, no new posts are created or published. Existing posts, drafts and account data stay available.</p>
      <label className="social-check"><input type="checkbox" checked={form.createBlogDrafts} onChange={event => setForm({ ...form, createBlogDrafts: event.target.checked })} />
        <span><strong>Also create blog drafts</strong><small>Create an article answering the same prompt in Agents. Blog articles are never published automatically.</small></span></label>
      <div className="social-schedule-heading"><div><h3>Weekly schedule</h3><p className="card-description">{form.slots.length} {form.slots.length === 1 ? 'time' : 'times'} per week, per connected account{form.createBlogDrafts ? ', plus a blog draft' : ''}.</p></div>
        <label className="field social-timezone"><span>Timezone</span><input value={form.timezone} list={`${uniqueId}-zones`} onChange={event => setForm({ ...form, timezone: event.target.value })} required aria-label="Publishing timezone" />
          <datalist id={`${uniqueId}-zones`}>{['UTC', 'Asia/Nicosia', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Jerusalem', 'Australia/Sydney'].map(zone => <option key={zone} value={zone} />)}</datalist></label></div>
      <div className="social-slots">{form.slots.map((slot, index) => <div key={slot.id} className="social-slot">
        <label className="field"><span>Day {index + 1}</span><select aria-label={`Publishing day ${index + 1}`} value={slot.dayOfWeek} onChange={event => setForm({ ...form, slots: form.slots.map(item => item.id === slot.id ? { ...item, dayOfWeek: Number(event.target.value) } : item) })}>{weekdays.map((day, dayOfWeek) => <option key={day} value={dayOfWeek}>{day}</option>)}</select></label>
        <label className="field"><span>Time</span><input type="time" aria-label={`Publishing time ${index + 1}`} value={slot.time} required onChange={event => setForm({ ...form, slots: form.slots.map(item => item.id === slot.id ? { ...item, time: event.target.value } : item) })} /></label>
        <button type="button" className="icon-button" aria-label={`Remove publishing time ${index + 1}`} onClick={() => setForm({ ...form, slots: form.slots.filter(item => item.id !== slot.id) })}><Trash2 size={17} /></button>
      </div>)}</div>
      <button type="button" className="button button-outline" onClick={addSlot} disabled={form.slots.length >= MAX_SOCIAL_AUTOMATION_SLOTS || !owner || saving}><Plus size={15} />Add publishing time</button>
      <p className="social-help">Times follow your selected timezone. A time skipped by daylight saving is skipped; a repeated time runs once.</p>
      {!data.generationAvailable && <p className="social-readiness">Content generation needs setup before automation can be enabled.</p>}
      {!data.publishingAvailable && <p className="social-readiness">Social publishing needs setup. Blog drafts can still run when blog generation is available.</p>}
      {!data.blogAvailable && form.createBlogDrafts && <p className="social-readiness">Blog draft generation needs setup before it can be included.</p>}
    </fieldset>
    {!owner && <p className="social-help">Only a project owner can change automation settings.</p>}
    <ErrorNotice error={error} />
    <div className="social-save-row"><Badge value={data.settings.scheduleStatus === 'synced' ? 'completed' : data.settings.scheduleStatus === 'error' ? 'failed' : 'queued'} label={`Schedule ${data.settings.scheduleStatus}`} />
      <button type="submit" className="button button-primary" disabled={!owner || saving || !dirty}><Save size={15} />{saving ? 'Saving…' : 'Save automation settings'}</button></div>
  </form>;
}

function DestinationForm({ connection, value, version, path, owner, onSaved, notify }: {
  connection: Connection; value?: { boardId?: string; subreddit?: string; flairId?: string }; version: number;
  path: string; owner: boolean; onSaved: () => void; notify: (message: string) => void;
}) {
  const pinterest = connection.channel === 'pinterest';
  const [boardId, setBoardId] = useState(value?.boardId || '');
  const [subreddit, setSubreddit] = useState(value?.subreddit || '');
  const [flairId, setFlairId] = useState(value?.flairId || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const boards = useApi<{ items: { id: string; name: string }[] }>(pinterest ? `${path}/social/accounts/${encodeURIComponent(connection.id)}/boards` : null);
  const dirty = boardId !== (value?.boardId || '') || subreddit !== (value?.subreddit || '') || flairId !== (value?.flairId || '');
  async function save(event: FormEvent) {
    event.preventDefault(); if (!owner || saving) return; setError(undefined); setSaving(true);
    try {
      await request(`${path}/social/destinations`, { method: 'PATCH', body: JSON.stringify({ version, destinationId: connection.id,
        ...(pinterest ? { boardId } : { subreddit: subreddit.trim().replace(/^r\//, ''), ...(flairId.trim() ? { flairId: flairId.trim() } : {}) }) }) });
      notify('Publishing destination saved.'); onSaved();
    } catch (failure) { setError(failure as Error); } finally { setSaving(false); }
  }
  return <form className="social-destination-form" aria-label={`${labels[connection.channel]} destination for ${connection.username}`} onSubmit={save}>
    <h4>{labels[connection.channel]} · {connection.username}</h4>
    <fieldset disabled={!owner || saving}>
      {pinterest ? <label className="field"><span>Publishing board</span><select aria-label={`Pinterest board for ${connection.username}`} required value={boardId} onChange={event => setBoardId(event.target.value)}>
        <option value="">Choose a board</option>{boards.data?.items.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</select></label>
        : <><label className="field"><span>Community</span><input aria-label={`Reddit community for ${connection.username}`} placeholder="r/yourcommunity" value={subreddit} onChange={event => setSubreddit(event.target.value)} required /></label>
          <label className="field"><span>Post flair ID (if required)</span><input value={flairId} onChange={event => setFlairId(event.target.value)} /></label></>}
      <button type="submit" className="button button-outline" disabled={!owner || saving || !dirty || (pinterest && !boardId)}>{saving ? 'Saving…' : 'Save destination'}</button>
    </fieldset>
    {!(pinterest ? value?.boardId : value?.subreddit) && <p className="social-help">Choose a {pinterest ? 'board' : 'community'} before automated publishing can start for this account.</p>}
    <ErrorNotice error={error || boards.error} />
  </form>;
}

interface TikTokOptions {
  creator: { privacyLevels: string[]; canPostMore: boolean; interactions: { allowComment: boolean; allowDuet: boolean; allowStitch: boolean } };
  music: { id: string; name: string; artist: string; previewUrl?: string }[];
}
function TikTokApproval({ post, path, owner, enabled, onSaved, notify }: {
  post: SocialPublicationPreview; path: string; owner: boolean; enabled: boolean; onSaved: () => void; notify: (message: string) => void;
}) {
  const options = useApi<TikTokOptions>(`${path}/social/publications/${post.id}/tiktok-options`);
  const [privacyLevel, setPrivacyLevel] = useState('');
  const [musicSoundId, setMusicSoundId] = useState('');
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [expressConsentGiven, setExpressConsentGiven] = useState(false);
  const [interactions, setInteractions] = useState({ allowComment: false, allowDuet: false, allowStitch: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const track = options.data?.music.find(item => item.id === musicSoundId);
  const interactionsAllowed = options.data && (Object.keys(interactions) as (keyof typeof interactions)[]).every(name => !interactions[name] || options.data!.creator.interactions[name]);
  const ready = owner && enabled && options.data?.creator.canPostMore && options.data.creator.privacyLevels.includes(privacyLevel) && interactionsAllowed && track && previewConfirmed && expressConsentGiven;
  async function approve(event: FormEvent) {
    event.preventDefault(); if (!ready || saving) return; setSaving(true); setError(undefined);
    try {
      await request(`${path}/social/publications/${post.id}/approve`, { method: 'POST', body: JSON.stringify({ version: post.version,
        privacyLevel, musicSoundId, previewConfirmed, expressConsentGiven, ...interactions }) });
      notify('TikTok post approved for publishing.'); onSaved();
    } catch (failure) { setError(failure as Error); } finally { setSaving(false); }
  }
  return <form className="social-tiktok-review" onSubmit={approve} aria-label="Review TikTok publication">
    <h3>Review and publish to {post.destination}</h3>
    <ErrorNotice error={error || options.error} />
    {options.loading && !options.data && <Skeleton variant="form" label="Loading TikTok publishing choices…" />}
    {!owner && <p className="social-help">A project owner must approve this post.</p>}
    {!enabled && <p className="social-help">Automation is paused. Publishing approval is unavailable.</p>}
    {options.data && <fieldset disabled={!owner || !enabled || saving || !options.data.creator.canPostMore}>
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
      <label className="social-check"><input type="checkbox" checked={previewConfirmed} onChange={event => setPreviewConfirmed(event.target.checked)} /><span>I reviewed the video and caption above.</span></label>
      <label className="social-check"><input type="checkbox" checked={expressConsentGiven} onChange={event => setExpressConsentGiven(event.target.checked)} /><span>I authorize Citevia to publish this post to {post.destination} on TikTok.</span></label>
      <button type="submit" className="button button-primary" disabled={!ready || saving}>{saving ? 'Submitting…' : 'Approve and publish'}</button>
    </fieldset>}
  </form>;
}
