// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SharedSocialReview } from '@citevia/core';
import SharedSocialReviewPage from './SharedSocialReviewPage';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('requires loaded media and a reviewed selection, schedules matching destinations together and lets a failed destination retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T10:00:00Z'));
  const publication = { version: 2, destination: 'Hot coffee', scheduledAt: '2026-11-03T12:00:00Z', status: 'review_required' as const };
  const batch: SharedSocialReview = { timezone: 'UTC', expiresAt: '2026-11-09T10:00:00Z', creatives: [{ id: 'creative-one', brandName: 'Hot Coffee',
    content: { title: 'Espresso beans', body: 'Choose a fresh roast.', hashtags: [] },
    media: [{ type: 'image', url: 'https://media.test/images/one', mimeType: 'image/jpeg' }], publications: [
      { ...publication, id: 'facebook-post', channel: 'facebook' }, { ...publication, id: 'instagram-post', channel: 'instagram' },
    ] }] };
  let failed = true;
  const decisions: string[] = [], token = 'a'.repeat(64);
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).not.toContain(token);
    expect(options.headers).toMatchObject({ Authorization: 'Bearer ' + token });
    if (options.method === 'GET') return Response.json(batch);
    const { id, version, previewConfirmed, expressConsentGiven } = JSON.parse(String(options.body));
    expect({ version, previewConfirmed, expressConsentGiven }).toEqual({ version: 2, previewConfirmed: true, expressConsentGiven: true });
    decisions.push(id);
    return id === 'instagram-post' && failed ? Response.json({ error: { message: 'Disconnected account.' } }, { status: 409 }) : Response.json({ id, status: 'scheduled' });
  });
  vi.stubGlobal('fetch', fetch);
  const host = document.createElement('div'), root = createRoot(host);
  document.body.appendChild(host);
  try {
    await act(async () => root.render(<SharedSocialReviewPage hash={'#social-review/test-project/' + token} />));
    const article = host.querySelector('article')!;
    const submit = article.querySelector('button')!;
    const confirm = () => article.querySelector<HTMLInputElement>('.shared-decision input')!;
    const image = article.querySelector('.shared-images img')!;
    expect(submit.disabled).toBe(true); expect(confirm().disabled).toBe(true);
    expect(article.querySelectorAll('li')).toHaveLength(2);
    await act(async () => { image.dispatchEvent(new Event('load')); });
    expect(confirm().disabled).toBe(false); expect(submit.disabled).toBe(true);
    await act(async () => confirm().click());
    const account = article.querySelector<HTMLInputElement>('li input')!;
    await act(async () => account.click());
    expect(confirm().checked).toBe(false); expect(submit.disabled).toBe(true);
    await act(async () => account.click());
    await act(async () => confirm().click());
    await act(async () => submit.click());
    expect(decisions).toEqual(['facebook-post', 'instagram-post']);
    expect(article.querySelector('li')?.textContent).toContain('Scheduled');
    expect(article.querySelector('[role=alert]')?.textContent).toBe('Disconnected account.');
    expect(submit.disabled).toBe(true);
    failed = false;
    await act(async () => confirm().click());
    await act(async () => submit.click());
    expect(decisions).toEqual(['facebook-post', 'instagram-post', 'instagram-post']);
    expect(article.querySelector('button')).toBeNull();
    expect(article.querySelectorAll('.tag.scheduled')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
