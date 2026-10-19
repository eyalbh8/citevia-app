import { describe, expect, it } from 'vitest';
import { containsAlias, parseExtraction, validateExtraction, verifySpan } from '../src/extraction.js';
import { normalizeAnswer } from '../src/normalize.js';
import { absent, captured, competitor, instant, snapshot, target } from './fixtures.js';

const noMention = (brandId: string) => { const { mentionOrder: _order, ...value } = absent(brandId); return value; };
const mention = (text: string, overrides: Record<string, unknown> = {}) => ({ brandId: target.id, mentioned: true, explicitRank: null, sentiment: 'positive',
  evidence: [{ blockId: 'block-1', quote: text, start: 0, end: text.length }], rankEvidence: null, sentimentEvidence: { blockId: 'block-1', quote: text, start: 0, end: text.length }, ...overrides });

describe('evidence extraction', () => {
  it('treats no mention as a successful observation', () => {
    const values = validateExtraction({ brands: [noMention(target.id), noMention(competitor.id)] }, captured('Neither brand appears.'), [target, competitor]);
    expect(values.map(value => value.mentioned)).toEqual([false, false]);
    expect(values[0].sentiment).toBe('not_applicable');
  });
  it('keeps recommendation rank separate from first mention order', () => {
    const text = 'Acme is useful.\n2. Acme is useful.';
    const first = { blockId: 'block-1', quote: 'Acme is useful.', start: 0, end: 15 };
    const rank = { blockId: 'block-1', quote: '2. Acme is useful.', start: 16, end: text.length };
    const rows = validateExtraction({ brands: [mention(text, { evidence: [first], explicitRank: 2, rankEvidence: rank })] }, captured(text), [target]);
    expect(rows[0]).toMatchObject({ explicitRank: 2, mentionOrder: 1 });
  });
  it('orders brand aliases within shared evidence by their actual positions', () => {
    const text = '🧭 Bravo and Acme are useful.';
    const first = mention(text, { brandId: competitor.id });
    const second = mention(text);
    const rows = validateExtraction({ brands: [second, first] }, captured(text), [target, competitor]);
    expect(rows.find(row => row.brandId === target.id)!.mentionOrder).toBe(2);
    expect(rows.find(row => row.brandId === competitor.id)!.mentionOrder).toBe(1);
  });
  it('rejects claimed ranks without an explicit number', () => {
    const text = 'Acme is useful.';
    expect(() => validateExtraction({ brands: [mention(text, { explicitRank: 1, rankEvidence: { blockId: 'block-1', quote: text, start: 0, end: text.length } })] }, captured(text), [target])).toThrow('Rank is not supported');
  });
  it('repairs Unicode/code-point offsets only with unique exact evidence', () => {
    const answer = captured('🧭 Acme is useful.');
    const span = { blockId: 'block-1', quote: 'Acme', start: 2, end: 6 };
    expect(verifySpan(span, answer.blocks)).toEqual({ ...span, start: 3, end: 7 });
  });
  it('corrects out-of-range end offsets rather than persisting invalid spans', () => {
    const span = { blockId: 'block-1', quote: 'Acme', start: 0, end: 999 };
    expect(verifySpan(span, captured('Acme').blocks)).toEqual({ ...span, end: 4 });
  });
  it('rejects ambiguous duplicate evidence when offsets are wrong', () => {
    expect(() => verifySpan({ blockId: 'block-1', quote: 'Acme', start: 1, end: 5 }, captured('Acme and Acme').blocks)).toThrow('unambiguous');
  });
  it('rejects fabricated evidence or aliases that are only substrings', () => {
    expect(() => validateExtraction({ brands: [mention('Acme is excellent.')] }, captured('Acme is useful.'), [target])).toThrow('unambiguous');
    expect(containsAlias('Acmeology is useful', target)).toBe(false);
    expect(containsAlias('Try (ACME).', target)).toBe(true);
    expect(containsAlias('C++ is useful', { ...target, name: 'C++', aliases: [] })).toBe(true);
  });
  it('rejects duplicate, missing and unknown brand objects', () => {
    expect(() => validateExtraction({ brands: [noMention(target.id), noMention(target.id)] }, captured(), [target, competitor])).toThrow('exactly one');
    expect(() => validateExtraction({ brands: [noMention('invented')] }, captured(), [target])).toThrow('unknown or missing');
  });
  it('rejects invented citations and extra properties in structured analysis', () => {
    expect(() => validateExtraction({ brands: [mention('Acme', { citations: ['https://invented.example'] })] }, captured('Acme'), [target])).toThrow('schema');
  });
  it('fails closed for malformed extraction JSON', () => {
    expect(() => parseExtraction({ receivedAt: instant, requestId: 'r', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] } }, captured(), snapshot)).toThrow('valid JSON');
  });
});

describe('native answer normalization', () => {
  it('collects citations from all output blocks and keeps retrieved sources separate', () => {
    const native = { id: 'resp-multi', model: 'snapshot', status: 'completed', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, output: [
      { type: 'reasoning', id: 'reasoning-1', summary: [] },
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://retrieved.example', title: 'Retrieved only' }] } },
      { type: 'message', content: [
        { type: 'output_text', text: 'First answer', annotations: [{ type: 'url_citation', url: 'https://cited.example/one', title: 'First', start_index: 0, end_index: 5 }] },
        { type: 'output_text', text: 'Second answer', annotations: [{ type: 'url_citation', url: 'https://cited.example/two', title: 'Second', start_index: 0, end_index: 6 }] },
      ] },
      { type: 'message', content: [{ type: 'output_text', text: 'Third answer', annotations: [{ type: 'url_citation', url: 'javascript:alert(1)' }] }] },
    ] };
    const result = normalizeAnswer({ response: native, requestId: 'request-id', receivedAt: instant }, 'fallback');
    expect(result.blocks).toHaveLength(3);
    expect(result.citations.map(citation => citation.url)).toEqual(['https://cited.example/one', 'https://cited.example/two']);
    expect(result.citations[1].blockId).toBe('output_2_content_1');
    expect(result.sources).toEqual([{ url: 'https://retrieved.example', title: 'Retrieved only' }]);
    expect(result.raw).toEqual({ response: native, requestId: 'request-id', receivedAt: instant });
    expect(result.usage.totalTokens).toBe(30);
  });
  it('retains refusals, incomplete reasons and their usage as evidence', () => {
    const native = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer.' }] }], usage: { total_tokens: 40 } };
    const result = normalizeAnswer({ response: native, requestId: null, receivedAt: instant }, 'fallback');
    expect(result.status).toBe('refused');
    expect(result.refusal).toBe('Cannot answer.');
    expect(result.usage.totalTokens).toBe(40);
    expect(result.raw).toMatchObject({ response: { incomplete_details: { reason: 'max_output_tokens' } } });
  });
});
