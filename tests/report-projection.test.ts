import { describe, expect, it } from 'vitest';
import { publicSourceUrl, publicReportMarkdown } from '@citevia/core';

describe('public citation destinations', () => {
  it('preserves the exact cited page or removes the destination', () => {
    const original = 'https://www.xtrade.com/en/help-center/real-and-demo-accounts/';
    expect(publicSourceUrl(original)).toBeNull();
    for (const url of [
      'https://DEMO.example.org/', 'https://example.org/?kind=%64%65%6d%6f', 'https://example.org/#demos',
      'https://example.org/%2564%2565%256d%256f', 'https://example.org/%E2%82%AC%64emo',
      'https://example.org/a/[…]-account', 'https://example.org/a/%5B%E2%80%A6%5D',
      'https://name:secret@site.org/path', 'javascript:alert(1)', 'https://app.citevia.io.evil.org/demo-content/id/slug',
    ]) expect(publicSourceUrl(url)).toBeNull();
    const normal = 'https://example.org/Demographics?variant=B&lang=en#fig1';
    expect(publicSourceUrl(normal)).toBe(normal);
    expect(publicSourceUrl('https://example.org/page?variant=B&utm_content=DEMO#fig1')).toBe('https://example.org/page?variant=B#fig1');
    expect(publicSourceUrl('https://app.citevia.io/demo-content/account_demo_1/fees')).toBe('https://app.citevia.io/articles/YWNjb3VudF9kZW1vXzE/fees');
  });
  it('drops inline, nested, reference and bare destinations and keeps labels, sources and legitimate words', () => {
    const original = [
      'A **de**mo account. Democracy. Demographics.',
      '[Help [guide]](https://xtrade.com/a_(demo)) and [practice FAQ][1].',
      '[1]: https://example.org/%64%65%6D%6F',
      '<https://demo.gov/test> and www.example.org/demos.',
      '[Account fees](https://example.org/fees#costs)',
      '![Image](https://example.org/demo/photo.jpg)',
      '`https://example.org/%64%65%6D%6F` and d&#101;mo',
      '<a href="https://example.org/demo">Details</a>',
    ].join('\n\n');
    const output = publicReportMarkdown(original);
    expect(output).toContain('Help');
    expect(output).toContain('practice FAQ');
    expect(output).toContain('https://example.org/fees#costs');
    expect(output).toContain('Democracy. Demographics.');
    expect(output).not.toMatch(/\bdemos?\b|xtrade\.com|%64%65|%6d%6f/i);
    expect(output).not.toContain('[…](');
    expect(publicReportMarkdown(output)).toBe(output);
  });
  it('leaves ordinary Markdown, evidence and code byte-for-byte intact', () => {
    const normal = '# A heading\n\n- **UK** pricing\n- [Rates](https://example.org/fees?lang=en#summary)\n\n`x = 5`\n';
    expect(publicReportMarkdown(normal)).toBe(normal);
    expect(publicReportMarkdown('[Study](https://example.org/guide?mode=DEMO)')).toBe('Study');
    expect(publicReportMarkdown('Read https://example.org/docs/demo.')).toBe('Read […].');
    expect(publicReportMarkdown('The demos were recorded.')).toBe('The […] were recorded.');
  });
});
