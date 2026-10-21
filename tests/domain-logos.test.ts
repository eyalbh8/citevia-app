import { describe, expect, it } from 'vitest';
import {
  domainLogoSources,
  logoDomain,
  logoInitials,
} from '../apps/client/src/domain-logos.js';

describe('domain logos', () => {
  it('normalizes cited URLs and subdomains to the same company without sharing path or query data', () => {
    expect(
      logoDomain(' HTTPS://WWW.XTRADE.COM/help?session=private#answer '),
    ).toBe('xtrade.com');
    expect(logoDomain('static.xtrade.com')).toBe('xtrade.com');
    expect(logoDomain('vertexaisearch.cloud.google.com/grounding-api')).toBe(
      'google.com',
    );
    expect(logoDomain('//docs.example.co.uk/path')).toBe('example.co.uk');
    expect(logoDomain('https://bücher.de/read')).toBe('xn--bcher-kva.de');
    expect(
      domainLogoSources(
        'https://www.xtrade.com/path?session=private',
        'pk_test',
      ).join(' '),
    ).not.toMatch(/session|private|path/);
  });

  it('keeps sites hosted on private suffixes distinct', () => {
    expect(logoDomain('https://team-one.github.io/docs')).toBe(
      'team-one.github.io',
    );
    expect(logoDomain('https://team-two.github.io/docs')).toBe(
      'team-two.github.io',
    );
  });

  it.each([
    undefined,
    '',
    'not a domain',
    'localhost',
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://[::1]',
    'https://intranet.internal',
    'ftp://example.com',
    'javascript:alert(1)',
    'data:image/png,logo',
    'https://user:password@example.com',
    'https://user@example.com',
  ])(
    'does not send unsafe or private identifiers to external image services: %s',
    (value) => {
      expect(domainLogoSources(value, 'pk_test')).toEqual([]);
    },
  );

  it('uses Logo.dev first with the public key, then a favicon fallback', () => {
    const sources = domainLogoSources(
      'https://www.stripe.com/pricing',
      ' pk_test ',
    );
    const logo = new URL(sources[0]);
    expect(logo.origin).toBe('https://img.logo.dev');
    expect(logo.pathname).toBe('/stripe.com');
    expect(logo.searchParams.get('token')).toBe('pk_test');
    expect(logo.searchParams.get('fallback')).toBe('404');
    expect(logo.searchParams.get('size')).toBe('64');
    expect(sources[1]).toBe(
      'https://www.google.com/s2/favicons?domain=stripe.com&sz=64',
    );
  });

  it('does not put secret keys or invalid keys into image requests', () => {
    for (const key of [undefined, '', 'sk_do_not_publish', 'invalid-key']) {
      expect(domainLogoSources('stripe.com', key)).toEqual([
        'https://www.google.com/s2/favicons?domain=stripe.com&sz=64',
      ]);
    }
  });

  it('provides readable initials when a logo cannot be loaded', () => {
    expect(logoInitials('North Star')).toBe('NS');
    expect(logoInitials('XTrade')).toBe('XT');
    expect(logoInitials('', 'https://stripe.com/pricing')).toBe('ST');
    expect(logoInitials('', '')).toBe('↗');
  });
});
