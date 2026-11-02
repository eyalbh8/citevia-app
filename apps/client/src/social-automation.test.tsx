// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSocialAutomationSettings, type Project } from '@citevia/core';
const mocks = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn(), onSaved: vi.fn(), notify: vi.fn() }));
vi.mock('./api', async () => ({ ...mocks, ApiError: (await import('./api-error')).ApiError }));
import SocialAutomationSettings, { type SocialPublicationPreview, type SocialSettingsResponse } from './SocialAutomationSettings';

const path = '/projects/social-test';
let root: Root, container: HTMLDivElement, data: SocialSettingsResponse, project: Project;
let posts: SocialPublicationPreview[];
let creator: { privacyLevels: string[]; canPostMore: boolean; interactions: { allowComment: boolean; allowDuet: boolean; allowStitch: boolean } };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  project = { id: 'social-test', version: 3, role: 'owner' } as Project;
  data = { settings: defaultSocialAutomationSettings(), version: 3, connections: [], publishingAvailable: true, generationAvailable: true, blogAvailable: true };
  posts = [];
  creator = { privacyLevels: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], canPostMore: true, interactions: { allowComment: true, allowDuet: false, allowStitch: true } };
  mocks.request.mockReset().mockImplementation(async (_path: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return body.settings ? { settings: { ...data.settings, ...body.settings }, version: 4 } : {};
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<SocialAutomationSettings project={project} path={path} onSaved={mocks.onSaved} notify={mocks.notify} />)); }
function button(text: string, scope: ParentNode = container) { return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
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
    media: [{ type: 'video', url: 'https://media.example/post.mp4', mimeType: 'video/mp4' }] };
}

describe('social automation settings', () => {
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
    expect(JSON.parse(options.body)).toEqual({ version: 3, settings: { enabled: true, createBlogDrafts: true, timezone: 'UTC',
      slots: [{ id: expect.stringMatching(/^slot_/), dayOfWeek: 1, time: '09:00' }] } });
    expect(mocks.notify).toHaveBeenCalledWith('Automation schedule saved.');
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
    expect(button('Approve and publish', preview)).toBeUndefined();
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
    expect(button('Approve and publish', form).disabled).toBe(true);
    await change(selects[0], 'PUBLIC_TO_EVERYONE'); await change(selects[1], 'track-one');
    await click(checkbox('I reviewed', form));
    expect(button('Approve and publish', form).disabled).toBe(true);
    await click(checkbox('I authorize', form));
    expect(button('Approve and publish', form).disabled).toBe(false);
    await click(button('Approve and publish', form));
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
