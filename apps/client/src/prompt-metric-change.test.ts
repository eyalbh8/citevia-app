// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PromptMetricComparison } from '@citevia/core';
import { PromptMetricChange } from './PromptsView';

const comparison: PromptMetricComparison = {
  mode: 'first_last_day',
  baseline: { start: '2026-10-20', end: '2026-10-20', measurementCount: 2 },
  current: { start: '2026-10-22', end: '2026-10-22', measurementCount: 2 },
  providers: ['gemini', 'openai'],
};
function render(value: number | null, metadata: PromptMetricComparison | null = comparison, metric: 'visibility' | 'sentiment' | 'rank' = 'visibility') {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(createElement(PromptMetricChange, { value, comparison: metadata, metric }));
  return container.firstElementChild!;
}

describe('prompt metric percentage changes', () => {
  it('shows genuine zero separately from unavailable and formats positive and negative percentages', () => {
    expect(render(0).textContent).toBe('0%');
    expect(render(0).classList.contains('unavailable')).toBe(false);
    expect(render(null, null).textContent).toBe('—');
    expect(render(null, null).classList.contains('unavailable')).toBe(true);
    expect(render(12.345).textContent).toBe('+12.35%');
    expect(render(12.345).classList.contains('improved')).toBe(true);
    expect(render(-4.65).textContent).toBe('-4.65%');
    expect(render(-4.65).classList.contains('declined')).toBe(true);
  });

  it('describes matched first/latest days without claiming a previous-week comparison', () => {
    const trend = render(5.26);
    const title = trend.getAttribute('title')!;
    expect(title).toContain('First to latest scan day: 2026-10-20 → 2026-10-22 UTC');
    expect(title).toContain('2 matched providers, one answer per provider');
    expect(title).toContain('Values above average the entire selected period');
    expect(title).toContain('Relative percent change, not percentage points');
    expect(title).not.toContain('Previous equal-length period');
    expect(trend.getAttribute('role')).toBe('img');
    expect(trend.getAttribute('aria-label')).toContain('Visibility change: +5.26%');
    expect(trend.getAttribute('aria-label')).toContain(title);
  });

  it('explains previous-window dates and analysis counts when those are the comparison basis', () => {
    const trend = render(0, {
      ...comparison,
      mode: 'previous_period',
      baseline: { start: '2026-10-09T00:00:00.000Z', end: '2026-10-15T23:59:59.999Z', measurementCount: 4 },
      current: { start: '2026-10-16T00:00:00.000Z', end: '2026-10-22T23:59:59.999Z', measurementCount: 6 },
    });
    expect(trend.getAttribute('title')).toContain('Previous equal-length period: 2026-10-09–2026-10-15 → 2026-10-16–2026-10-22 UTC');
    expect(trend.getAttribute('title')).toContain('4 → 6 analyzed answers');
  });

  it('labels rank improvement correctly and explains insufficient comparable scores', () => {
    expect(render(33.33, comparison, 'rank').getAttribute('title')).toContain('Positive means a lower, better rank');
    expect(render(null, comparison, 'sentiment').getAttribute('title')).toContain('No comparable score');
    expect(render(null, null).getAttribute('title')).toContain('two distinct scan days');
  });
});
