import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { trafficTracker } from '../apps/api/src/traffic-tracker.js';

function website(
  url = 'https://site.example/',
  referrer = 'https://chatgpt.com/',
) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { url, referrer, runScripts: 'outside-only' },
  );
  const script = dom.window.document.createElement('script');
  script.src = 'https://api.example/v1/traffic/tracker.js';
  script.setAttribute('data-project-id', 'project-a');
  Object.defineProperty(dom.window.document, 'currentScript', {
    value: script,
  });
  Object.defineProperty(dom.window.crypto, 'randomUUID', { value: randomUUID });
  const fetcher = vi.fn().mockResolvedValue({});
  Object.defineProperty(dom.window, 'fetch', { value: fetcher });
  return { dom, fetcher, run: () => dom.window.eval(trafficTracker) };
}
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
      keepalive: true,
    });
    expect(JSON.parse(f.fetcher.mock.calls[0][1].body)).toMatchObject({
      projectId: 'project-a',
      referrer: 'https://chatgpt.com/',
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
      'https://chatgpt.com/',
    );
    f.dom.window.close();
  });
  it('only sends recognized referrers or supported UTM tags and includes the exact connection token', () => {
    for (const ref of [
      'https://evil.example/?from=chatgpt.com',
      'https://chatgpt.com.evil.example/',
    ]) {
      const f = website('https://site.example/', ref);
      f.run();
      expect(f.fetcher).not.toHaveBeenCalled();
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
    });
    f.dom.window.history.replaceState({}, '', '/pricing');
    expect(JSON.parse(f.fetcher.mock.calls.at(-1)![1].body).testId).toBe(id);
    f.dom.window.close();
  });
});
