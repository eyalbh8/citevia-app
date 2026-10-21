import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AnswerMarkdown from './AnswerMarkdown';

const render = (text: string, preview = false) =>
  renderToStaticMarkup(
    createElement(AnswerMarkdown, {
      text,
      aliases: ['XTrade', 'C++'],
      preview,
    }),
  );

describe('saved answer formatting', () => {
  it('renders headings, emphasis, lists, tables, links and brand highlighting without changing code', () => {
    const html = render(
      '### What **XTrade** can provide\n\n* **Regulatory status:** factual details\n* *Documentation*\n\n| Item | Value |\n| --- | --- |\n| C++ | 1 |\n\n[Official source](https://example.com)\n\n`XTrade`\n\n---',
    );
    expect(html).toContain(
      '<h3>What <strong><mark>XTrade</mark></strong> can provide</h3>',
    );
    expect(html).toContain('<ul>');
    expect(html).toContain('<em>Documentation</em>');
    expect(html).toContain('<table>');
    expect(html).toContain('<mark>C++</mark>');
    expect(html).toContain('<code>XTrade</code>');
    expect(html).toContain(
      'href="https://example.com" target="_blank" rel="noreferrer noopener"',
    );
    expect(html).not.toContain('**');
  });
  it('ignores raw HTML, dangerous links and external image loads', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[bad](javascript:alert%281%29) ![image](https://tracking.example/image)\n\n**safe**',
    );
    expect(html).not.toMatch(/<script|<img|onerror=|href="javascript:|src=/);
    expect(html).toContain('<strong>safe</strong>');
  });
  it('renders noninteractive previews and matches brand boundaries', () => {
    const html = render(
      '**XTrade** XTradeable [XTrade](https://example.com)',
      true,
    );
    expect(html).not.toContain('<a ');
    expect(html.match(/<mark>XTrade<\/mark>/g)).toHaveLength(2);
    expect(html).toContain('XTradeable');
  });
});
