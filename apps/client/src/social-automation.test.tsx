// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSocialAutomationSettings, type Project } from '@citevia/core';
const mocks = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), onSaved: vi.fn(), notify: vi.fn() }));
vi.mock('./api', async () => ({ ...mocks, ApiError: (await import('./api-error')).ApiError }));
import { socialLocalDateTime, socialPublishingInstant } from './SocialPublicationReview';
import SocialAutomationSettings, { type SocialPublicationPreview, type SocialSettingsResponse } from './SocialAutomationSettings';

const path = '/projects/social-test';
let root: Root, container: HTMLDivElement, data: SocialSettingsResponse, project: Project;
let posts: SocialPublicationPreview[];
let creator: { privacyLevels: string[]; canPostMore: boolean; interactions: { allowComment: boolean; allowDuet: boolean; allowStitch: boolean } };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T08:00:00Z'));
  project = { id: 'social-test', version: 3, role: 'owner' } as Project;
  data = { settings: defaultSocialAutomationSettings(), version: 3, connections: [], publishingAvailable: true, generationAvailable: true, blogAvailable: true };
  posts = [];
  creator = { privacyLevels: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], canPostMore: true, interactions: { allowComment: true, allowDuet: false, allowStitch: true } };
  mocks.request.mockReset().mockImplementation(async (endpoint: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    if (body.settings) return { settings: { ...data.settings, ...body.settings }, version: 4 };
    if (options.method === 'PATCH' && endpoint.includes('/publications/')) return { ...posts[0], ...body, status: 'review_required', version: body.version + 1 };
    return {};
  });
  mocks.onSaved.mockReset(); mocks.notify.mockReset();
  mocks.useApi.mockReset().mockImplementation((endpoint: string | null) => {
    if (!endpoint) return { loading: false };
    if (endpoint.endsWith('/social')) return { data, loading: false };
    if (endpoint.includes('/publications?')) return { data: { items: posts, total: posts.length }, loading: false };
    if (endpoint.endsWith('/tiktok-options')) return { data: { creator, music: [{ id: 'track-one', name: 'Uplifting', artist: 'Artist', previewUrl: 'https://music.example/track.mp3' }] }, loading: false };
    if (endpoint.endsWith('/boards')) return { data: { items: [{ id: 'board-one', name: 'Brand ideas' }] }, loading: false };
    return { data: posts.find(post => endpoint.endsWith(`/${post.id}`)), loading: false };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<SocialAutomationSettings project={project} path={path} onSaved={mocks.onSaved} notify={mocks.notify} />)); }
function button(text: string, scope: ParentNode = container) { return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const schedule = () => container.querySelector<HTMLFormElement>('form[aria-label="Social automation settings"]')!;
const toggle = () => schedule().querySelector<HTMLButtonElement>('[role="switch"]')!;
const checkbox = (text: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLLabelElement>('label')].find(label => label.textContent?.includes(text))!.querySelector<HTMLInputElement>('input')!;
function post(channel: SocialPublicationPreview['channel'], status: SocialPublicationPreview['status'] = 'review_required'): SocialPublicationPreview {
  return { id: 'publication-test', prompt: 'How do we choose useful metrics?', promptId: 'prompt-1', channel, destination: 'Brand account', status,
    createdAt: '2026-11-02T09:00:00Z', scheduledAt: '2026-11-02T09:00:00Z', updatedAt: '2026-11-02T09:00:00Z', version: 2,
    content: { title: 'A useful answer', body: 'Start with a clear question.', hashtags: ['#Clarity'] },
    media: channel === 'tiktok' ? [{ type: 'video', url: 'https://media.example/post.mp4', mimeType: 'video/mp4' }] : [{ type: 'image', url: 'https://media.example/post.jpg', mimeType: 'image/jpeg' }] };
}

describe('social automation settings', () => {
  it.each(['weekly', 'monthly'] as const)('saves the %s preparation cadence separately from publishing slots', async cadence => {
    await render();
    await change(container.querySelector<HTMLSelectElement>('[aria-label="Content preparation frequency"]')!, cadence);
    await change(container.querySelector<HTMLInputElement>('[aria-label="Content preparation time"]')!, '07:30');
    await click(toggle()); await click(button('Add publishing time')); await click(button('Save automation settings'));
    const input = JSON.parse(mocks.request.mock.calls[0][1].body);
    expect(input.settings).toMatchObject({ generationCadence: cadence, generationTime: '07:30', slots: [{ dayOfWeek: 1, time: '09:00' }] });
    expect(schedule().textContent).toContain(cadence === 'weekly' ? 'Every Monday' : 'first day of each month');
    expect(schedule().textContent).toContain('only after your approval');
  });
  it('saves two weekly brand plans with isolated Facebook and Instagram accounts and independently editable times', async () => {
    data.settings.generationCadence = 'monthly';
    data.settings.slots = [{ id: 'legacy', dayOfWeek: 0, time: '18:30' }];
    data.blogAvailable = false;
    for (const brand of ['Hot', 'Iced']) {
      for (const channel of ['facebook', 'instagram'] as const) {
        data.connections.push({ id: `${brand}-${channel}`, channel, username: `${brand} Coffee`, active: true, requiresReconnect: false });
      }
    }
    data.connections.push({ id: 'old-facebook', channel: 'facebook', username: 'Old Page', active: true, requiresReconnect: true });
    await render();
    function field(scope: Element, label: string) {
      return [...scope.querySelectorAll('label')].find(item => item.firstElementChild?.textContent === label)!
        .querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')!;
    }
    for (const [index, brand] of ['Hot', 'Iced'].entries()) {
      await click(button('Add brand'));
      const plan = schedule().querySelectorAll('.social-brand-plan')[index];
      await change(field(plan, 'Brand name'), `${brand} Coffee`);
      await change(field(plan, 'What does this brand promote?'), brand === 'Hot' ? 'Espresso and coffee beans' : 'Cold coffee served over ice');
      const facebook = field(plan, 'Facebook account') as HTMLSelectElement;
      expect(facebook.querySelector<HTMLOptionElement>('[value="old-facebook"]')!.disabled).toBe(true);
      expect(facebook.querySelector('[value="Hot-instagram"]')).toBeNull();
      if (brand === 'Iced') expect(facebook.querySelector<HTMLOptionElement>('[value="Hot-facebook"]')!.disabled).toBe(true);
      await change(facebook, `${brand}-facebook`);
      await change(field(plan, 'Instagram account'), `${brand}-instagram`);
      await click(checkbox('Use the same post', plan));
      await change(field(plan, 'Publishing times per week'), brand === 'Hot' ? '10' : '2');
    }
    expect(schedule().textContent).toContain('12 unique posts · 24 destination publications');
    const plans = schedule().querySelectorAll('.social-brand-plan');
    await change(plans[0].querySelector<HTMLInputElement>('[aria-label="Publishing time 1"]')!, '13:35');
    await change(plans[0].querySelector<HTMLSelectElement>('[aria-label="Publishing day 1"]')!, '5');
    expect(plans[1].querySelector<HTMLInputElement>('[aria-label="Publishing time 1"]')!.value).toBe('09:00');
    expect(schedule().textContent).toContain('Every Monday');
    expect(schedule().querySelector('[aria-label="Content preparation frequency"]')).toBeNull();
    await click(toggle()); await click(button('Save automation settings'));
    expect(mocks.request).toHaveBeenCalledOnce();
    const saved = JSON.parse(mocks.request.mock.calls[0][1].body).settings;
    expect(saved).toMatchObject({ enabled: true, generationCadence: 'monthly', slots: [{ id: 'legacy' }], brands: [
      { name: 'Hot Coffee', description: 'Espresso and coffee beans', facebookDestinationId: 'Hot-facebook', instagramDestinationId: 'Hot-instagram', shareFacebookInstagramContent: true },
      { name: 'Iced Coffee', description: 'Cold coffee served over ice', facebookDestinationId: 'Iced-facebook', instagramDestinationId: 'Iced-instagram', shareFacebookInstagramContent: true },
    ] });
    expect(saved.brands[0].slots).toHaveLength(10);
    expect(saved.brands[0].slots[0]).toMatchObject({ dayOfWeek: 5, time: '13:35' });
    expect(saved.brands[1].slots).toHaveLength(2);
  });
  it('restores the saved project schedule after the last brand is removed', async () => {
    data.settings.generationCadence = 'monthly';
    data.settings.brands = [{ id: 'hot', name: 'Hot Coffee', description: 'Espresso and coffee beans',
      facebookDestinationId: 'hot-fb', instagramDestinationId: 'hot-ig', shareFacebookInstagramContent: true,
      slots: [{ id: 'tuesday', dayOfWeek: 2, time: '13:30' }] }];
    data.settings.slots = [{ id: 'legacy', dayOfWeek: 5, time: '17:30' }];
    await render();
    expect(schedule().textContent).toContain('Unavailable account (hot-fb)');
    expect(schedule().textContent).toContain('1 unique post · 2 destination publications');
    await click(button('Remove brand'));
    expect(schedule().querySelector<HTMLSelectElement>('[aria-label="Content preparation frequency"]')!.value).toBe('monthly');
    expect(schedule().querySelector<HTMLInputElement>('[aria-label="Publishing time 1"]')!.value).toBe('17:30');
    await click(button('Save automation settings'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body).settings).toMatchObject({ brands: [], slots: [{ id: 'legacy' }] });
  });
  it('starts generation for the saved period only when automation is enabled', async () => {
    await render(); expect(button('Generate content now').disabled).toBe(true);
    data.settings.enabled = true; await render(); await click(button('Generate content now'));
    expect(mocks.request).toHaveBeenCalledWith(`${path}/social/generate`, { method: 'POST', body: JSON.stringify({ version: 3 }) });
    expect(mocks.notify).toHaveBeenCalledWith('Content preparation started. Posts will wait for your review.');
  });
  it('requires an explicit save and sends only the editable schedule fields', async () => {
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(checkbox('Also create blog drafts').checked).toBe(true);
    await click(toggle()); await click(button('Add publishing time'));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(schedule().textContent).toContain('1 time per week');
    await click(button('Save automation settings'));
    expect(mocks.request).toHaveBeenCalledOnce();
    const [endpoint, options] = mocks.request.mock.calls[0];
    expect(endpoint).toBe(`${path}/social/settings`); expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ version: 3, settings: { enabled: true, createBlogDrafts: true, imageSource: 'openai', shareFacebookInstagramContent: false, generationCadence: 'daily', generationTime: '08:00', timezone: 'UTC',
      slots: [{ id: expect.stringMatching(/^slot_/), dayOfWeek: 1, time: '09:00' }] } });
    expect(mocks.notify).toHaveBeenCalledWith('Automation schedule saved.');
  });
  it('defaults legacy projects to OpenAI and saves the Unsplash choice explicitly', async () => {
    data.settings.imageSource = undefined;
    data.unsplashAvailable = true;
    await render();
    expect(container.querySelector<HTMLInputElement>('input[value="openai"]')!.checked).toBe(true);
    await click(container.querySelector<HTMLInputElement>('input[value="unsplash"]')!);
    expect(mocks.request).not.toHaveBeenCalled();
    await click(button('Save automation settings'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body).settings.imageSource).toBe('unsplash');
  });
  it('shows Unsplash photographer credit and source links next to reviewed photos', async () => {
    const prepared = post('facebook');
    const photo = { url: 'https://images.unsplash.com/photo-test', alt: 'A relevant photo', photoId: 'photo-test', photographer: 'Photo Author',
      photographerUrl: 'https://unsplash.com/@author', photoUrl: 'https://unsplash.com/photos/photo-test', downloadLocation: 'https://api.unsplash.com/photos/photo-test/download' };
    prepared.media = [{ type: 'image', url: photo.url, mimeType: 'image/jpeg', attribution: [photo] }];
    posts = [prepared];
    await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    const credit = container.querySelector('.social-photo-credit')!;
    expect(credit.textContent).toContain('Photo by Photo Author on Unsplash');
    expect([...credit.querySelectorAll('a')].map(link => link.href)).toEqual([photo.photographerUrl, photo.photoUrl]);
  });
  it('blocks enabling Unsplash for connected accounts until configured', async () => {
    data.connections = [{ id: 'fb', channel: 'facebook', username: 'Page', active: true, requiresReconnect: false }];
    await render();
    await click(container.querySelector<HTMLInputElement>('input[value="unsplash"]')!);
    await click(toggle()); await click(button('Add publishing time')); await click(button('Save automation settings'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unsplash images are not configured');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('keeps shared Facebook/Instagram content opt-in and saves the toggle explicitly', async () => {
    data.settings.shareFacebookInstagramContent = undefined;
    await render();
    const shared = checkbox('Use the same post for Facebook and Instagram');
    expect(shared.checked).toBe(false);
    expect(container.textContent).toContain('including Instagram carousels');
    await click(shared);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(schedule().textContent).toContain('edits affect only that destination');
    await click(button('Save automation settings'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body).settings.shareFacebookInstagramContent).toBe(true);
  });
  it('pauses without deleting existing data or changing the scan toggle', async () => {
    data.settings.enabled = true; data.settings.slots = [{ id: 'monday', dayOfWeek: 1, time: '09:00' }];
    await render(); await click(toggle()); await click(button('Save automation settings'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body).settings.enabled).toBe(false);
    expect(mocks.request.mock.calls[0][0]).not.toBe(`${path}/settings`);
    expect(mocks.notify).toHaveBeenCalledWith('Automation paused. Your posts and drafts are preserved.');
  });
  it('keeps viewer controls disabled and rejects a forced submit', async () => {
    project.role = 'viewer'; await render();
    expect(toggle().disabled).toBe(true); expect(button('Add publishing time').disabled).toBe(true);
    expect(button('Save automation settings').disabled).toBe(true);
    await act(async () => schedule().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('can schedule blog creation with no social connections and labels drafts as unpublished', async () => {
    data.publishingAvailable = false; posts = [{ ...post('blog', 'draft_created'), media: undefined, draftPostId: 'saved-blog' }];
    await render(); await click(toggle()); await click(button('Add publishing time')); await click(button('Save automation settings'));
    expect(mocks.request).toHaveBeenCalledOnce();
    await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    const preview = container.querySelector('.social-preview')!;
    expect(preview.textContent).toContain('Blog draft only');
    expect(preview.textContent).toContain('It does not publish to your website.');
    expect(preview.querySelector('a')?.getAttribute('href')).toBe('#agents');
    expect(button('Approve and schedule', preview)).toBeUndefined();
  });
  it('blocks duplicate weekly times and unavailable generation before writing', async () => {
    await render(); await click(toggle()); await click(button('Add publishing time')); await click(button('Add publishing time'));
    await change(container.querySelector<HTMLInputElement>('[aria-label="Publishing time 2"]')!, '09:00');
    await click(button('Save automation settings'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unique'); expect(mocks.request).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove publishing time 2"]')!);
    data.generationAvailable = false; await render(); await click(button('Save automation settings'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not configured'); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('saves explicit Pinterest and Reddit destinations with the project version', async () => {
    data.connections = [
      { id: 'pin-account', channel: 'pinterest', username: 'Brand pins', active: true, requiresReconnect: false },
      { id: 'reddit-account', channel: 'reddit', username: 'Brand reddit', active: true, requiresReconnect: false },
    ];
    await render();
    const pinterest = container.querySelector<HTMLFormElement>('form[aria-label="Pinterest destination for Brand pins"]')!;
    await change(pinterest.querySelector('select')!, 'board-one'); await click(button('Save destination', pinterest));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ version: 3, destinationId: 'pin-account', boardId: 'board-one' });
    const reddit = container.querySelector<HTMLFormElement>('form[aria-label="Reddit destination for Brand reddit"]')!;
    await change(reddit.querySelector('input')!, 'r/analytics'); await click(button('Save destination', reddit));
    expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toEqual({ version: 3, destinationId: 'reddit-account', subreddit: 'analytics' });
  });
  it('shows missing TikTok video setup without blocking blog automation', async () => {
    data.videoAvailable = false;
    data.connections = [{ id: 'tik-account', channel: 'tiktok', username: 'Brand video', active: true, requiresReconnect: false }];
    await render();
    expect(container.textContent).toContain('Video setup needed');
    expect(container.textContent).toContain('Other connected accounts and blog drafts can still run.');
    await click(toggle()); await click(button('Add publishing time')); await click(button('Save automation settings'));
    expect(mocks.request).toHaveBeenCalledOnce();
  });
});

describe('editable scheduled social posts', () => {
  async function preview(channel: SocialPublicationPreview['channel'] = 'facebook', status: SocialPublicationPreview['status'] = 'review_required') {
    data.settings.enabled = true; posts = [post(channel, status)]; await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    return container.querySelector<HTMLFormElement>('form[aria-label="Edit prepared post"]')!;
  }
  it('requires explicit preview and permission for Facebook before scheduling', async () => {
    await preview();
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Approve scheduled publication"]')!;
    expect(button('Approve and schedule', form).disabled).toBe(true);
    await click(checkbox('I reviewed', form)); await click(checkbox('I authorize', form)); await click(button('Approve and schedule', form));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ version: 2, previewConfirmed: true, expressConsentGiven: true });
    expect(mocks.notify).toHaveBeenCalledWith('Post approved. It will publish at the scheduled time.');
  });
  it('does not mistake reordered JSON object keys from storage for unsaved edits', async () => {
    data.settings.enabled = true;
    posts = [{ ...post('facebook'), content: { hashtags: ['#Clarity'], body: 'Start with a clear question.', title: 'A useful answer' } }];
    await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    expect(button('Save post changes').disabled).toBe(true);
    const approval = container.querySelector<HTMLFormElement>('form[aria-label="Approve scheduled publication"]')!;
    expect(approval.querySelector('fieldset')!.disabled).toBe(false);
  });
  it('blocks approval of unsaved edits and saves the chosen timezone time with the changed text', async () => {
    data.settings.timezone = 'America/New_York';
    const editor = await preview();
    await change(editor.querySelector<HTMLTextAreaElement>('[aria-label="Post text"]')!, 'Edited answer for this platform.');
    await change(editor.querySelector<HTMLInputElement>('[aria-label="Post hashtags"]')!, 'Clarity Results');
    await change(editor.querySelector<HTMLInputElement>('[aria-label="Post publishing date and time"]')!, '2026-11-03T10:15');
    expect(container.querySelector<HTMLFormElement>('form[aria-label="Approve scheduled publication"] fieldset')!.disabled).toBe(true);
    await click(button('Save post changes', editor));
    const payload = JSON.parse(mocks.request.mock.calls[0][1].body);
    expect(payload).toMatchObject({ version: 2, content: { body: 'Edited answer for this platform.', hashtags: ['#Clarity', '#Results'] }, scheduledAt: '2026-11-03T15:15:00.000Z' });
    const approval = container.querySelector<HTMLFormElement>('form[aria-label="Approve scheduled publication"]')!;
    expect(checkbox('I authorize', approval).checked).toBe(false);
    await click(checkbox('I reviewed', approval)); await click(checkbox('I authorize', approval)); await click(button('Approve and schedule', approval));
    expect(JSON.parse(mocks.request.mock.calls[1][1].body).version).toBe(3);
  });
  it('requires a new approval after editing an already scheduled post', async () => {
    const editor = await preview('linkedin', 'scheduled');
    expect(container.textContent).toContain('Any saved edit or media replacement removes approval');
    expect(button('Approve and schedule')).toBeUndefined();
    await change(editor.querySelector<HTMLTextAreaElement>('textarea')!, 'Revised text.'); await click(button('Save post changes', editor));
    expect(button('Approve and schedule').disabled).toBe(true);
  });
  it('preserves asset identities when carousel images are reordered and removed', async () => {
    data.settings.enabled = true;
    posts = [{ ...post('instagram'), media: [
      { id: 'asset-1', type: 'image', url: 'https://media.example/one.jpg', mimeType: 'image/jpeg' },
      { id: 'asset-2', type: 'image', url: 'https://media.example/two.jpg', mimeType: 'image/jpeg' },
      { id: 'asset-3', type: 'image', url: 'https://media.example/three.jpg', mimeType: 'image/jpeg' },
    ] }];
    await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Move image 2 earlier"]')!);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove image 3"]')!);
    await click(button('Save post changes'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body).media.map((item: { id: string }) => item.id)).toEqual(['asset-2', 'asset-1']);
  });
  it('refreshes signed preview URLs in the open editor without dirtying the post or losing local edits', async () => {
    data.settings.enabled = true;
    posts = [{ ...post('instagram'), media: [
      { id: 'asset-1', type: 'image', url: 'https://media.example/one.jpg?signature=old', mimeType: 'image/jpeg' },
      { id: 'asset-2', type: 'image', url: 'https://media.example/two.jpg?signature=old', mimeType: 'image/jpeg' },
    ] }];
    await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    const renew = (signature: string) => { posts = [{ ...posts[0], media: posts[0].media!.map(asset => ({ ...asset, url: asset.url.replace(/signature=[^&]+/, `signature=${signature}`) })) }]; };
    renew('renewed'); await render();
    expect([...container.querySelectorAll<HTMLImageElement>('.social-editor-media img')].every(image => image.src.includes('signature=renewed'))).toBe(true);
    expect(button('Save post changes').disabled).toBe(true);
    await change(container.querySelector<HTMLTextAreaElement>('[aria-label="Post text"]')!, 'Keep my unsaved answer.');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Move image 2 earlier"]')!);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Remove image 2"]')!);
    renew('latest'); await render();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Post text"]')!.value).toBe('Keep my unsaved answer.');
    const images = [...container.querySelectorAll<HTMLImageElement>('.social-editor-media img')];
    expect(images.map(image => image.src)).toEqual(['https://media.example/two.jpg?signature=latest']);
    expect(button('Save post changes').disabled).toBe(false);
    expect(button('Approve and schedule').disabled).toBe(true);
    await click(button('Save post changes'));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({ content: { body: 'Keep my unsaved answer.' }, media: [{ id: 'asset-2', url: 'https://media.example/two.jpg?signature=latest' }] });
  });
  it('uploads a replacement directly to signed storage without forwarding app authorization', async () => {
    const editor = await preview();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock);
    mocks.request.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/media/start')) return { uploadId: 'upload-1', url: 'https://storage.example/upload', fields: { policy: 'signed-policy', key: 'private-key' } };
      return { ...posts[0], version: 3, media: [{ id: 'asset-new', type: 'image', url: 'https://media.example/new.jpg', mimeType: 'image/jpeg' }] };
    });
    const file = new File(['image data'], 'replacement.jpg', { type: 'image/jpeg' });
    const input = editor.querySelector<HTMLInputElement>('[aria-label="Replace image 1"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ version: 2, filename: 'replacement.jpg', mimeType: 'image/jpeg', size: file.size, replaceIndex: 0 });
    expect(fetchMock).toHaveBeenCalledWith('https://storage.example/upload', { method: 'POST', body: expect.any(FormData), credentials: 'omit', redirect: 'error' });
    const uploaded = fetchMock.mock.calls[0][1].body as FormData;
    expect(uploaded.get('policy')).toBe('signed-policy'); expect(uploaded.get('file')).toBe(file);
    expect(mocks.request.mock.calls[1][0]).toBe(`${path}/social/publications/publication-test/media/complete`);
    expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toEqual({ version: 2, uploadId: 'upload-1' });
    expect(editor.querySelector('img')?.src).toBe('https://media.example/new.jpg');
  });
  it('shows upload failures and keeps the original preview', async () => {
    const editor = await preview();
    mocks.request.mockRejectedValue(new Error('Upload is unavailable. Try again.'));
    const input = editor.querySelector<HTMLInputElement>('[aria-label="Replace image 1"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { value: [new File(['image'], 'x.png', { type: 'image/png' })] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(editor.querySelector('[role="alert"]')?.textContent).toContain('Upload is unavailable');
    expect(editor.querySelector('img')?.src).toBe('https://media.example/post.jpg');
  });
  it('prevents a viewer from editing even with a forced submit', async () => {
    project.role = 'viewer'; const editor = await preview();
    expect(editor.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => editor.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('requires a new future time for an unapproved post whose time passed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T08:00:00Z'));
    await preview(); expect(container.textContent).toContain('This publishing time has passed');
    expect(button('Approve and schedule').disabled).toBe(true);
  });
});

describe('publishing dates in the project timezone', () => {
  it('uses the project timezone, rejects a daylight-saving gap and chooses the first repeated time', () => {
    expect(socialLocalDateTime('2026-11-03T15:15:00Z', 'America/New_York')).toBe('2026-11-03T10:15');
    expect(() => socialPublishingInstant('2026-03-08T02:30', 'America/New_York')).toThrow('clocks change');
    expect(socialPublishingInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(socialPublishingInstant('2026-11-01T01:30', 'America/New_York', '2026-11-01T06:30:00Z')).toBe('2026-11-01T06:30:00Z');
  });
});

describe('TikTok publication review', () => {
  async function preview() {
    data.settings.enabled = true; posts = [post('tiktok')]; await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    return container.querySelector<HTMLFormElement>('form[aria-label="Review TikTok publication"]')!;
  }
  it('requires fresh privacy, music, preview and publishing consent without preselected interaction permissions', async () => {
    const form = await preview();
    const selects = form.querySelectorAll<HTMLSelectElement>('select');
    expect(selects[0].value).toBe(''); expect(selects[1].value).toBe('');
    expect([...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => !input.checked)).toBe(true);
    expect(checkbox('Allow Duet', form).disabled).toBe(true);
    expect(button('Approve and schedule', form).disabled).toBe(true);
    await change(selects[0], 'PUBLIC_TO_EVERYONE'); await change(selects[1], 'track-one');
    await click(checkbox('I reviewed', form));
    expect(button('Approve and schedule', form).disabled).toBe(true);
    await click(checkbox('I authorize', form));
    expect(button('Approve and schedule', form).disabled).toBe(false);
    await click(button('Approve and schedule', form));
    expect(mocks.request.mock.calls[0][0]).toBe(`${path}/social/publications/publication-test/approve`);
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ version: 2, privacyLevel: 'PUBLIC_TO_EVERYONE', musicSoundId: 'track-one',
      previewConfirmed: true, expressConsentGiven: true, allowComment: false, allowDuet: false, allowStitch: false });
  });
  it.each(['viewer', 'paused', 'limit'] as const)('prevents approval for %s', async reason => {
    if (reason === 'viewer') project.role = 'viewer';
    if (reason === 'limit') creator.canPostMore = false;
    const form = await preview();
    if (reason === 'paused') { data.settings.enabled = false; await render(); }
    expect(form.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('displays post text safely and ignores unsafe media URLs', async () => {
    posts = [{ ...post('facebook', 'published'), content: { title: 'Preview', body: '<script>alert(1)</script>', hashtags: [] },
      media: [{ type: 'image', url: 'javascript:alert(1)', mimeType: 'image/png' }] }];
    await render(); await click(container.querySelector<HTMLButtonElement>('.social-history-row')!);
    expect(container.querySelector('.social-preview-copy')?.textContent).toBe('<script>alert(1)</script>');
    expect(container.querySelector('.social-preview script')).toBeNull(); expect(container.querySelector('.social-preview-media img')).toBeNull();
  });
  it('keeps keyboard focus inside the preview and restores the selected post on Escape', async () => {
    data.settings.enabled = true; posts = [post('tiktok')]; await render();
    const row = container.querySelector<HTMLButtonElement>('.social-history-row')!;
    row.focus(); await click(row);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(checkbox('I authorize', dialog));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close details');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});

describe('owner client review handoff', () => {
  it('selects eligible versions across the batch, drops changed versions and lets the owner copy or revoke the link', async () => {
    data.settings.enabled = true;
    const candidates = Array.from({ length: 24 }, (_, index) => ({
      id: 'candidate-' + index, version: 3, brandName: index < 20 ? 'Hot Coffee' : 'Iced Coffee', title: 'Coffee ' + index,
      channel: index % 2 ? 'instagram' : 'facebook', destination: 'Coffee account',
      scheduledAt: '2026-11-09T10:00:00Z', shareable: index !== 0,
    }));
    const link = { id: 'grant', url: 'https://app.citevia.io/#social-review/coffee/test', expiresAt: '2026-11-09T10:00:00Z',
      createdAt: '2026-11-02T10:00:00Z', publicationCount: 22, publications: [] as { id: string; version: number }[] };
    let active = false;
    const original = mocks.useApi.getMockImplementation()!;
    mocks.useApi.mockImplementation((endpoint: string | null) => {
      if (endpoint?.includes('clientReview=true')) return { data: { items: candidates, total: candidates.length } };
      if (endpoint?.endsWith('/review-links')) return { data: { items: active ? [link] : [] } };
      return original(endpoint);
    });
    mocks.request.mockImplementation(async (_endpoint: string, options: RequestInit) => {
      active = options.method === 'POST';
      if (active) link.publications = JSON.parse(String(options.body)).publications;
      return active ? link : { revoked: true };
    });
    await render(); await click(button('Client review links'));
    expect(button('Create review link (0)').disabled).toBe(true);
    await click(checkbox('Select all eligible on this page (23)'));
    candidates[2].version = 4;
    await render();
    await click(button('Create review link (22)'));
    const [endpoint, options] = mocks.request.mock.calls[0];
    expect(endpoint).toBe(path + '/social/review-links');
    const { publications } = JSON.parse(options.body);
    expect(publications).toHaveLength(22);
    expect(publications).not.toContainEqual(expect.objectContaining({ id: 'candidate-0' }));
    expect(publications).not.toContainEqual(expect.objectContaining({ id: 'candidate-2' }));
    expect(publications).toContainEqual({ id: 'candidate-23', version: 3 });
    expect([...container.querySelectorAll('small')].filter(note => note.textContent === 'Included in an active client review link')).toHaveLength(22);
    expect(container.querySelector<HTMLInputElement>('.social-created-link input')?.value).toBe(link.url);
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
    try {
      await click(button('Copy review link')); expect(copy).toHaveBeenCalledWith(link.url);
      await click(button('Revoke'));
      expect(mocks.request).toHaveBeenLastCalledWith(endpoint + '/grant', { method: 'DELETE' });
      expect(container.querySelector('.social-created-link')).toBeNull();
    } finally { Reflect.deleteProperty(navigator, 'clipboard'); }
  });

  it('exposes link management only to project owners', async () => {
    project.role = 'viewer';
    await render();
    expect(button('Client review links')).toBeUndefined();
  });
});
