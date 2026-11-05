// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Brandbook } from '@citevia/core';
import BrandbookView from './BrandbookView';

const { useApi, request } = vi.hoisted(() => ({ useApi: vi.fn(), request: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<object>(), useApi, request }));

it('hides the word in editable fields and preserves untouched source values on save', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const url = 'https://brand.example/demo', about = 'A company offering private demo sessions to customers.';
  const brandbook: Brandbook = {
    about, industryCategory: 'Services', subIndustryCategory: 'Research', companyCountry: 'GB', language: 'en',
    names: ['Brand'], domains: ['brand.example'], keyFeatures: [], toneOfVoice: [], values: [], personality: [],
    targetAudience: [], knowledgeSources: [url], sitemapUrl: null, caseStudiesSourceUrl: null, caseStudies: [],
    postGuidelines: { dos: [], donts: [] }, evidence: [{ field: 'about', quote: 'A Demo session', url }],
    unknowns: [], generatedAt: '2026-11-05T00:00:00Z', model: 'research', version: 1, generationId: 'research-1',
  };
  useApi.mockReturnValue({ data: { brandbook, version: 3, role: 'owner' } });
  const host = document.createElement('div'), root = createRoot(host);
  try {
    await act(async () => root.render(<BrandbookView path="/account" onSaved={vi.fn()} notify={vi.fn()} />));
    expect(host.textContent).not.toMatch(/\bdemo\b/i);
    expect([...host.querySelectorAll('textarea')].every(el => !/\bdemo\b/i.test(el.value))).toBe(true);
    expect(host.querySelector('blockquote + a[href]')).toBeNull();
    expect(host.querySelector('textarea')?.disabled).toBe(false);
    expect(host.querySelector('textarea')?.value).toContain('[…]');
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ about, knowledgeSources: [url], evidence: brandbook.evidence });
  } finally {
    await act(async () => root.unmount());
  }
});
