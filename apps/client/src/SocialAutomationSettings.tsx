import { reportExcerpt } from './report-excerpt';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { CalendarClock, Check, FileText, Plus, RefreshCw, Save } from 'lucide-react';
import { MAX_SOCIAL_AUTOMATION_SLOTS, SOCIAL_CHANNELS, socialAutomationInputSchema,
  type Project, type SocialAutomationInput, type SocialAutomationSettings as AutomationSettings, type SocialChannel,
  type SocialDestination, type SocialPublication } from '@citevia/core';
import { request, useApi } from './api';
import { Badge, Drawer, ErrorNotice, Pagination, safeUrl } from './components';
import { Skeleton } from './Loading';
import SocialPublicationReview from './SocialPublicationReview';
import SocialReviewLinks from './SocialReviewLinks';
import SocialPhotoCredit from './SocialPhotoCredit';
import SocialBrandPlans, { PublishingTimes } from './SocialBrandPlans';
import './social-automation.css';

type Connection = Omit<SocialDestination, 'profileId'>;
export interface SocialSettingsResponse {
  settings: AutomationSettings;
  version: number;
  connections: Connection[];
  destinationOptions?: Project['socialDestinationOptions'];
  publishingAvailable: boolean;
  generationAvailable: boolean;
  unsplashAvailable?: boolean;
  blogAvailable: boolean;
  videoAvailable?: boolean;
}
export interface SocialPublicationPreview {
  id: string;
  brandName?: string;
  clientApproved?: boolean;
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
  editable?: boolean;
}
const labels: Record<SocialChannel | 'blog', string> = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', pinterest: 'Pinterest', reddit: 'Reddit', tiktok: 'TikTok', blog: 'Blog draft',
};
const statusLabels: Record<SocialPublication['status'], string> = {
  queued: 'Queued', generating: 'Creating', review_required: 'Review needed', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published',
  draft_created: 'Draft created', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Publication unconfirmed',
};
const editableSettings = (settings: AutomationSettings): SocialAutomationInput => ({
  enabled: settings.enabled, createBlogDrafts: settings.createBlogDrafts, shareFacebookInstagramContent: settings.shareFacebookInstagramContent ?? false,
  imageSource: settings.imageSource ?? 'openai',
  ...(settings.brands !== undefined && { brands: settings.brands }),
  generationCadence: settings.generationCadence ?? 'daily', generationTime: settings.generationTime ?? '08:00', timezone: settings.timezone, slots: settings.slots.map(slot => ({ ...slot })),
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
  const [sharing, setSharing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<Error>();
  const state = useApi<SocialSettingsResponse>(`${path}/social`, project.version + revision);
  const history = useApi<{ items: SocialPublicationPreview[]; total: number }>(`${path}/social/publications?offset=${page * 20}`, revision);
  const detail = useApi<SocialPublicationPreview>(selectedId ? `${path}/social/publications/${encodeURIComponent(selectedId)}` : null, revision);
  const owner = project.role === 'owner' && !project.demo;
  const brandPlans = Boolean(state.data?.settings.brands?.length);
  const pending = history.data?.items.some(post => ['queued', 'generating', 'publishing'].includes(post.status));
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => refresh(value => value + 1), 10000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const saved = () => { refresh(value => value + 1); onSaved(); };
  const post = detail.data?.id === selectedId ? detail.data : undefined;
  async function generateNow() {
    if (!owner || generating || !state.data?.settings.enabled) return;
    setGenerating(true); setGenerationError(undefined);
    try {
      await request(`${path}/social/generate`, { method: 'POST', body: JSON.stringify({ version: state.data.version }) });
      notify('Content preparation started. Posts will wait for your review.'); saved();
    } catch (error) { setGenerationError(error as Error); }
    finally { setGenerating(false); }
  }
  return <section className="card social-automation" aria-labelledby="social-automation-title">
    <div className="card-header">
      <div><h2 id="social-automation-title" className="card-title">Automated social media</h2>
        <p className="card-description">Prepare content ahead of time, review and edit it, then approve scheduled publishing.</p></div>
      <CalendarClock size={22} aria-hidden="true" />
    </div>
    <div className="card-content">
      <ErrorNotice error={state.error} retry={() => refresh(value => value + 1)} />
      {state.loading && !state.data && <Skeleton variant="form" label="Loading social automation settings…" />}
      {state.data?.settings && <>
        <AutomationForm key={`${project.id}-${state.data.settings.revision}`} data={state.data} path={path} owner={owner} onSaved={saved} notify={notify} />
        <div className="social-connected-heading"><h3>Publishing destinations</h3><a className="button button-outline" href="#integrations">Manage connections</a></div>
        {brandPlans ? <p className="card-description">Brand plans publish to their assigned Facebook and Instagram accounts. Connect another account in Manage connections to make it available to a brand.</p>
          : <p className="card-description">Each publishing time uses one active prompt for every ready account. {state.data.settings.shareFacebookInstagramContent
            ? 'Facebook and Instagram share the same short caption and single image for new posts.'
            : 'Posts use each platform’s own format, including Instagram carousels.'} Each destination tracks its own approval and publishing status.</p>}
        <div className="social-connections">
          {SOCIAL_CHANNELS.filter(channel => !brandPlans || channel === 'facebook' || channel === 'instagram').map(channel => {
            const accounts = state.data!.connections.filter(connection => connection.channel === channel);
            const ready = accounts.some(connected);
            const needsDestination = accounts.some(account => connected(account) &&
              ((channel === 'pinterest' && !state.data!.destinationOptions?.[account.id]?.boardId) ||
               (channel === 'reddit' && !state.data!.destinationOptions?.[account.id]?.subreddit)));
            const label = !state.data!.publishingAvailable ? 'Setup needed' : !accounts.length ? 'Not connected' : !ready ? 'Reconnect' :
              needsDestination ? 'Choose destination' : !state.data!.generationAvailable ? 'Generation setup needed' :
              channel === 'tiktok' && state.data!.videoAvailable === false ? 'Video setup needed' : brandPlans ? 'Connected' : 'Review before publishing';
            return <div key={channel} className={`social-connection ${ready ? 'is-connected' : ''}`}>
              <div><strong>{labels[channel]}</strong><span>{accounts.map(account => account.username).join(', ') || 'Connect an account to include it'}</span></div>
              <span className="social-connection-status">{ready && <Check size={13} aria-hidden="true" />}{label}</span>
            </div>;
          })}
        </div>
        {!brandPlans && state.data.connections.filter(connection => connected(connection) && ['pinterest', 'reddit'].includes(connection.channel)).map(connection =>
          <DestinationForm key={`${connection.id}-${JSON.stringify(state.data!.destinationOptions?.[connection.id] || {})}`}
            connection={connection} value={state.data!.destinationOptions?.[connection.id]} version={state.data!.version}
            path={path} owner={owner} onSaved={saved} notify={notify} />)}
        {!brandPlans && <p className="social-help">Review the text and media for every social post before approving its publishing time. For TikTok, also choose music, privacy and interaction permissions.</p>}
        {!brandPlans && state.data.videoAvailable === false && state.data.connections.some(connection => connection.channel === 'tiktok' && connected(connection)) &&
          <p className="social-readiness">TikTok posts will start once video creation is configured. Other connected accounts and blog drafts can still run.</p>}
      </>}
      <div className="social-connected-heading"><div><h3>Review and publishing queue</h3><p className="card-description">Unapproved posts stay here and are never published.</p></div><div className="social-queue-actions">
        {owner && <button type="button" className="button button-outline" onClick={() => setSharing(true)}>Client review links</button>}
        <button type="button" className="button button-outline" disabled={!owner || generating || !state.data?.settings.enabled} onClick={generateNow}>{generating ? 'Preparing…' : 'Generate content now'}</button>
        <button type="button" className="button button-outline" onClick={() => refresh(value => value + 1)}><RefreshCw size={14} />Refresh</button></div></div>
      <ErrorNotice error={generationError} />
      <ErrorNotice error={history.error} retry={() => refresh(value => value + 1)} />
      {history.loading && !history.data && <Skeleton variant="table" rows={3} label="Loading automated posts…" />}
      {history.data && !history.data.items.length && <p className="social-empty">Prepared posts and blog drafts will appear here. Choose a preparation cadence and publishing times, then save to get started.</p>}
      <div className="social-history">
        {history.data?.items.map(item => <button type="button" className="social-history-row" key={item.id} onClick={() => setSelectedId(item.id)}>
          <div><span className="social-history-channel">{item.brandName && `${item.brandName} · `}{labels[item.channel]} · {item.destination}</span><strong>{reportExcerpt(item.content?.title || item.prompt)}</strong>
            <span>{timestamp(item.scheduledAt, state.data?.settings?.timezone)}{item.clientApproved && ' · Approved via client link'}</span></div>
          <Badge value={item.status === 'draft_created' || item.status === 'published' ? 'completed' : item.status === 'review_required' ? 'partial' : item.status} label={statusLabels[item.status]} />
        </button>)}
      </div>
      {(history.data?.total || 0) > 20 && <Pagination page={page} total={history.data!.total} size={20} onChange={setPage} />}
    </div>
    {sharing && owner && <Drawer title="Client review links" onClose={() => setSharing(false)}>
      <SocialReviewLinks path={path} timezone={state.data?.settings.timezone || 'UTC'} enabled={state.data?.settings.enabled === true} notify={notify} />
    </Drawer>}
    {selectedId && <Drawer title={post ? [post.brandName, `${labels[post.channel]} preview`].filter(Boolean).join(' · ') : 'Post preview'} onClose={() => setSelectedId(undefined)}>
      <ErrorNotice error={detail.error} retry={() => refresh(value => value + 1)} />
      {!post && !detail.error && <Skeleton variant="form" label="Loading post preview…" />}
      {post && <div className="social-preview">
        <Badge value={post.status} label={statusLabels[post.status]} />
        <p className="card-description">Destination · {post.destination}</p>
        <p className="card-description">Answering: {reportExcerpt(post.prompt)}</p>
        {post.channel !== 'blog' && ['review_required', 'scheduled'].includes(post.status)
          ? <SocialPublicationReview key={`${post.id}-${post.version}`} post={post} path={path} owner={owner}
              enabled={state.data?.settings.enabled === true} timezone={state.data?.settings.timezone || 'UTC'} onSaved={saved} notify={notify} />
          : <>
        <h3>{reportExcerpt(post.content?.title || 'Post in progress')}</h3>
        <div className="social-preview-media">{post.media?.map((media, index) => {
          const url = safeUrl(media.url); if (!url) return null;
          return <div key={url}>{media.type === 'video' ? <video src={url} controls preload="metadata" aria-label="Post video" /> : <img src={url} alt={`Post image ${index + 1}`} />}<SocialPhotoCredit photos={media.attribution} /></div>;
        })}</div>
        <p className="social-preview-copy">{reportExcerpt(post.content?.body || '')}</p>
        {Boolean(post.content?.hashtags.length) && <p className="social-preview-tags">{reportExcerpt(post.content!.hashtags.join(' '))}</p>}
          </>}
        <ErrorNotice error={post.error?.message} />
        {post.status === 'uncertain' && <p className="social-readiness">Publication could not be confirmed. Check the connected account before creating another post with this content.</p>}
        {post.channel === 'blog' && <div className="social-blog-note"><FileText size={19} /><div><strong>Blog draft only</strong><p>This automation creates the article in Agents. It does not publish to your website.</p><a href="#agents" className="button button-outline" onClick={() => setSelectedId(undefined)}>Open blog drafts</a></div></div>}
        {post.publishedUrl && safeUrl(post.publishedUrl) && <a href={safeUrl(post.publishedUrl)} className="button button-outline" target="_blank" rel="noreferrer noopener">View published post</a>}
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
  const usingBrands = Boolean(form.brands?.length);
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
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const brand = issue.path[0] === 'brands' && typeof issue.path[1] === 'number' ? form.brands?.[issue.path[1]] : undefined;
      setError(new Error(brand?.name ? `${brand.name} · ${issue.message}` : issue.message));
      return;
    }
    if (form.enabled && !data.generationAvailable) { setError(new Error('Content generation is not configured yet.')); return; }
    if (form.enabled && form.imageSource === 'unsplash' && !data.unsplashAvailable && data.connections.some(connected)) { setError(new Error('Unsplash images are not configured yet. Choose OpenAI or contact your administrator.')); return; }
    if (form.enabled && !usingBrands && form.createBlogDrafts && !data.blogAvailable) { setError(new Error('Blog draft generation is not configured yet.')); return; }
    if (form.enabled && !usingBrands && !form.createBlogDrafts && !data.connections.some(connected)) { setError(new Error('Connect a social account or include blog drafts before enabling automation.')); return; }
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
      <fieldset className="social-image-source" aria-describedby={`${uniqueId}-image-help`}>
        <legend>Post image source</legend>
        <div className="social-image-options">
          <label className={`social-image-option ${form.imageSource === 'unsplash' ? 'is-selected' : ''}`}>
            <input type="radio" name={`${uniqueId}-image-source`} value="unsplash" checked={form.imageSource === 'unsplash'} onChange={() => setForm({ ...form, imageSource: 'unsplash' })} />
            <span><strong>Unsplash</strong><small>Find a photo related to the post topic.</small></span>
          </label>
          <label className={`social-image-option ${form.imageSource === 'openai' ? 'is-selected' : ''}`}>
            <input type="radio" name={`${uniqueId}-image-source`} value="openai" checked={form.imageSource === 'openai'} onChange={() => setForm({ ...form, imageSource: 'openai' })} />
            <span><strong>OpenAI</strong><small>Generate an original image for the post.</small></span>
          </label>
        </div>
        <p className="social-help" id={`${uniqueId}-image-help`}>Applies to new posts for connected social accounts, including carousel photos and video backgrounds. Unsplash photos are checked for relevance to the post. Blog drafts keep their own images.</p>
        {form.imageSource === 'unsplash' && !data.unsplashAvailable && <p className="social-readiness">Unsplash needs setup before it can create images for connected accounts. Choose OpenAI or contact your administrator.</p>}
      </fieldset>
      <SocialBrandPlans brands={form.brands || []} connections={data.connections} generationTime={form.generationTime}
        onChange={brands => setForm({ ...form, brands: brands.length ? brands : baseline.brands && [] })} />
      {!usingBrands && <><label className="social-check"><input type="checkbox" checked={form.createBlogDrafts} onChange={event => setForm({ ...form, createBlogDrafts: event.target.checked })} />
        <span><strong>Also create blog drafts</strong><small>Create an article answering the same prompt in Agents. Blog articles are never published automatically.</small></span></label>
      <label className="social-check"><input type="checkbox" checked={form.shareFacebookInstagramContent} onChange={event => setForm({ ...form, shareFacebookInstagramContent: event.target.checked })} />
        <span><strong>Use the same post for Facebook and Instagram</strong><small>Generate one short, general caption and one image for both at each publishing time. Destinations have independent approvals and publishing times. Saved edits affect only that destination.</small></span></label></>}
      <div className="social-preparation-settings">
        <div><h3>Content preparation</h3><p className="card-description">Choose how much content to create ahead of your publishing times.</p></div>
        <div className="social-preparation-fields">
          {usingBrands ? <p className="social-brand-cadence"><strong>Every Monday</strong><small>Prepare the week’s brand posts together.</small></p> : <label className="field"><span>Prepare content</span><select aria-label="Content preparation frequency" value={form.generationCadence} onChange={event => setForm({ ...form, generationCadence: event.target.value as SocialAutomationInput['generationCadence'] })}>
            <option value="daily">Every day</option><option value="weekly">Once a week</option><option value="monthly">Once a month</option>
          </select></label>}
          <label className="field"><span>Preparation time</span><input type="time" aria-label="Content preparation time" value={form.generationTime} required onChange={event => setForm({ ...form, generationTime: event.target.value })} /></label>
        </div>
        <label className="field social-timezone"><span>Timezone</span><input value={form.timezone} list={`${uniqueId}-zones`} onChange={event => setForm({ ...form, timezone: event.target.value })} required aria-label="Publishing timezone" />
          <datalist id={`${uniqueId}-zones`}>{['UTC', 'Asia/Nicosia', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Jerusalem', 'Australia/Sydney'].map(zone => <option key={zone} value={zone} />)}</datalist></label>
        <p className="social-help">{usingBrands ? 'Choose Monday publishing times after the preparation time. Saving an enabled plan prepares the rest of this week.' : <>{form.generationCadence === 'monthly' ? 'On the first day of each month, prepare posts for the rest of that calendar month.' : form.generationCadence === 'weekly' ? 'Every Monday, prepare posts for the rest of the week, through Sunday.' : 'Every day, prepare posts for that day’s remaining publishing times.'} Preparation uses your selected timezone. Saving an enabled schedule also prepares the remaining period now.</>}</p>
      </div>
      {!usingBrands && <><div className="social-schedule-heading"><div><h3>Publishing times</h3><p className="card-description">{form.slots.length} {form.slots.length === 1 ? 'time' : 'times'} per week, per connected account{form.createBlogDrafts ? ', plus a blog draft' : ''}.</p></div></div>
      <PublishingTimes slots={form.slots} onChange={slots => setForm({ ...form, slots })} />
      <button type="button" className="button button-outline" onClick={addSlot} disabled={form.slots.length >= MAX_SOCIAL_AUTOMATION_SLOTS || !owner || saving}><Plus size={15} />Add publishing time</button></>}
      <p className="social-help">Posts are published at these times only after your approval. Unapproved posts remain drafts; choose a new future time if a publishing time passes. Times follow your selected timezone. A time skipped by daylight saving is skipped; a repeated time runs once.</p>
      {!data.generationAvailable && <p className="social-readiness">Content generation needs setup before automation can be enabled.</p>}
      {!data.publishingAvailable && <p className="social-readiness">Social publishing needs setup.{!usingBrands && ' Blog drafts can still run when blog generation is available.'}</p>}
      {!usingBrands && !data.blogAvailable && form.createBlogDrafts && <p className="social-readiness">Blog draft generation needs setup before it can be included.</p>}
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
