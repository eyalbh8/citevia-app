import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { trafficTracker } from '../apps/api/src/traffic-tracker.js';

function website(
  url = 'https://site.example/',
  referrer = 'https://chatgpt.com/',
  projectId = 'project-a',
) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { url, ...(referrer ? { referrer } : {}), runScripts: 'outside-only' },
  );
  const script = dom.window.document.createElement('script');
  script.src = 'https://api.example/v1/traffic/tracker.js';
  script.setAttribute('data-project-id', projectId);
  Object.defineProperty(dom.window.document, 'currentScript', {
    value: script,
  });
  Object.defineProperty(dom.window.crypto, 'randomUUID', {
    value: randomUUID,
    configurable: true,
  });
  const fetcher = vi.fn().mockResolvedValue({});
  Object.defineProperty(dom.window, 'fetch', { value: fetcher });
  return { dom, fetcher, run: () => dom.window.eval(trafficTracker) };
}
afterEach(() => vi.restoreAllMocks());
describe('embedded referral tracker', () => {
  it('sends no cookies, avoids preflight, derives its collector from its own URL and does not install twice', () => {
    const f = website();
    f.run();
    f.run();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.example/v1/traffic/collect',
    );
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      referrerPolicy: 'origin',
      keepalive: true,
    });
    expect(JSON.parse(f.fetcher.mock.calls[0][1].body)).toMatchObject({
      projectId: 'project-a',
      referrer: 'https://chatgpt.com',
    });
    expect(f.dom.window.document.cookie).toBe('');
    f.dom.window.close();
  });
  it('tracks SPA navigation once per URL and preserves the original referral', () => {
    const f = website();
    f.run();
    f.dom.window.history.pushState({}, '', '/pricing');
    f.dom.window.history.replaceState({}, '', '/pricing');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.fetcher.mock.calls[1][1].body).url).toBe(
      'https://site.example/pricing',
    );
    expect(JSON.parse(f.fetcher.mock.calls[1][1].body).referrer).toBe(
      'https://chatgpt.com',
    );
    f.dom.window.close();
  });
  it('sends ordinary SPA visits as one installation heartbeat per 30 minutes, including online reconnects', () => {
    const f = website('https://site.example/', '');
    let now = Date.parse('2026-10-22T12:00:00Z');
    vi.spyOn(f.dom.window.Date, 'now').mockImplementation(() => now);
    f.run();
    f.dom.window.history.pushState({}, '', '/pricing');
    f.dom.window.history.replaceState({}, '', '/contact');
    f.dom.window.dispatchEvent(new f.dom.window.Event('online'));
    now += 30 * 60 * 1000 - 1;
    f.dom.window.history.pushState({}, '', '/checkout');
    expect(f.fetcher).toHaveBeenCalledOnce();
    now += 1;
    f.dom.window.history.pushState({}, '', '/thanks');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.fetcher.mock.calls[1][1].body)).toMatchObject({
      type: 'installation',
      url: 'https://site.example/thanks',
    });
    f.dom.window.close();
  });
  it('keeps the passive heartbeat across reloads and scopes it to the origin, project and browser session', () => {
    const first = website('https://site.example/', '');
    first.run();
    const key = first.dom.window.sessionStorage.key(0)!;
    const timestamp = first.dom.window.sessionStorage.getItem(key)!;
    const reload = website('https://site.example/pricing', '');
    reload.dom.window.sessionStorage.setItem(key, timestamp);
    reload.run();
    expect(reload.fetcher).not.toHaveBeenCalled();
    for (const next of [
      website('https://site.example/contact', '', 'project-b'),
      website('https://other.example/', ''),
      website('https://site.example/new-session', ''),
    ]) {
      // A new session has no saved heartbeat; other projects/origins may share unrelated keys.
      if (!next.dom.window.location.pathname.includes('new-session'))
        next.dom.window.sessionStorage.setItem(key, timestamp);
      next.run();
      expect(next.fetcher).toHaveBeenCalledOnce();
      next.dom.window.close();
    }
    first.dom.window.close();
    reload.dom.window.close();
  });
  it('preserves every AI navigation and explicit connection test during an existing passive heartbeat window', () => {
    const passive = website('https://site.example/', '');
    passive.run();
    const key = passive.dom.window.sessionStorage.key(0)!;
    const timestamp = passive.dom.window.sessionStorage.getItem(key)!;
    const testId = randomUUID();
    for (const [url, referrer, type] of [
      ['https://site.example/', 'https://chatgpt.com/', 'pageview'],
      [`https://site.example/?citevia_test=${testId}`, '', 'installation'],
    ]) {
      const f = website(url, referrer);
      f.dom.window.sessionStorage.setItem(key, timestamp);
      f.run();
      f.dom.window.history.pushState({}, '', '/pricing');
      f.dom.window.history.replaceState({}, '', '/pricing');
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      for (const [, options] of f.fetcher.mock.calls)
        expect(JSON.parse(options.body)).toMatchObject({
          type,
          testId: type === 'installation' ? testId : null,
        });
      f.dom.window.close();
    }
    passive.dom.window.close();
  });
  it('still detects installation and throttles SPA visits when session storage is blocked', () => {
    const f = website('https://site.example/', '');
    Object.defineProperty(f.dom.window, 'sessionStorage', {
      get() { throw new Error('Storage blocked'); },
    });
    f.run();
    f.dom.window.history.pushState({}, '', '/pricing');
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.dom.window.close();
  });
  it('allows installation detection again after all delivery retries fail', () => {
    const f = website('https://site.example/', '');
    const retries: (() => void)[] = [];
    vi.spyOn(f.dom.window, 'setTimeout').mockImplementation((callback) => {
      retries.push(callback as () => void);
      return retries.length;
    });
    f.fetcher.mockImplementation(() => { throw new Error('Offline'); });
    f.run();
    retries[0]();
    retries[1]();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(new Set(f.fetcher.mock.calls.map(([, options]) => JSON.parse(options.body).id)).size).toBe(1);
    expect(f.dom.window.sessionStorage.length).toBe(0);
    f.fetcher.mockResolvedValue({});
    f.dom.window.dispatchEvent(new f.dom.window.Event('online'));
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    f.dom.window.close();
  });
  it('detects ordinary and unrecognized visits without attributing them to AI, and includes the exact connection token', () => {
    for (const ref of [
      'https://evil.example/?from=chatgpt.com',
      'https://chatgpt.com.evil.example/',
    ]) {
      const f = website('https://site.example/', ref);
      f.run();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(f.fetcher.mock.calls[0][1].body).type).toBe(
        'installation',
      );
      f.dom.window.close();
    }
    const id = randomUUID();
    const f = website(
      `https://site.example/?utm_source=chatgpt.com&citevia_test=${id}`,
      'https://example.com',
    );
    f.run();
    expect(JSON.parse(f.fetcher.mock.calls[0][1].body)).toMatchObject({
      utmSource: 'chatgpt.com',
      testId: id,
      type: 'installation',
    });
    f.dom.window.history.replaceState({}, '', '/pricing');
    expect(JSON.parse(f.fetcher.mock.calls.at(-1)![1].body).testId).toBe(id);
    f.dom.window.close();
  });
  it('detects a direct visit without AI tags and supports browsers without randomUUID', () => {
    const f = website('https://site.example/?email=private', '');
    Object.defineProperty(f.dom.window.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    f.run();
    const payload = JSON.parse(f.fetcher.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      type: 'installation',
      url: 'https://site.example/',
      trackerVersion: 'citevia-v2',
    });
    expect(payload.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(f.fetcher.mock.calls[0][1].body).not.toContain('private');
    f.dom.window.close();
  });
});
