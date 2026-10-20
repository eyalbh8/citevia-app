import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('./auth', () => ({
  getAccessToken: async () => 'isolated-test-session',
}));
import { onboardAccounts } from './api';
import LanguageSelect, { LANGUAGE_OPTIONS } from './LanguageSelect';

afterEach(() => vi.unstubAllGlobals());
describe('onboarding form API contract', () => {
  it('offers Italian as a display name while selecting the it API value', () => {
    expect(
      LANGUAGE_OPTIONS.find((option) => option.label === 'Italian (it)')?.code,
    ).toBe('it');
    const html = renderToStaticMarkup(
      createElement(LanguageSelect, { value: 'it', onChange: () => {} }),
    );
    expect(html).toMatch(
      /<option value="it" selected="">Italian \(it\)<\/option>/,
    );
    expect(html).not.toContain('value="Italian"');
  });
  it('posts exactly the four fields accepted by the API for the reported XTrade case', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], limitReached: false }), {
          status: 202,
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await onboardAccounts([
      {
        name: 'XTrade',
        website: 'https://www.xtrade.com',
        region: 'IT',
        language: 'it',
      },
    ]);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/onboarding/accounts');
    expect(JSON.parse(options.body as string)).toEqual({
      accounts: [
        {
          name: 'XTrade',
          website: 'https://www.xtrade.com',
          region: 'IT',
          language: 'it',
        },
      ],
    });
    expect(new Headers(options.headers).get('Idempotency-Key')).toBeTruthy();
  });
  it('rejects language names and obsolete fields before making an HTTP request', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(() =>
      onboardAccounts([
        {
          name: 'XTrade',
          website: 'https://www.xtrade.com',
          region: 'IT',
          language: 'Italian',
        },
      ]),
    ).toThrow();
    expect(() =>
      onboardAccounts([
        {
          name: 'XTrade',
          website: 'https://www.xtrade.com',
          region: 'IT',
          language: 'it',
          country: 'IT',
        } as never,
      ]),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
