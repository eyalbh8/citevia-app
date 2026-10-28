import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project, ResponseDetail } from '@citevia/core';
import PresentationScenarioNotice from './PresentationScenarioNotice';
import { ResponseDetailContent } from './ResponseDrawer';

const demo: NonNullable<Project['demo']> = {
  version: 1,
  source: 'website-demo',
  anchorDate: '2026-10-28',
  startDate: '2026-04-28',
  endDate: '2027-04-28',
  sourceAccountId: 'example',
  sourceCopiedAt: '2026-10-28T00:00:00.000Z',
};

function answerDetail(raw: unknown): ResponseDetail {
  const at = '2026-10-28T06:00:00.000Z';
  const prompt = {
    id: 'prompt', text: 'Which brokers offer online accounts?', version: 1,
    active: true, branded: false, createdAt: at, updatedAt: at,
  };
  return {
    result: {
      projectId: 'xtrade', runId: 'run', promptId: prompt.id, responseId: 'response',
      prompt, status: 'succeeded', version: 1, attempts: 1,
      citationCount: 0, sourceCount: 0, capturedAt: at, expiresAt: 0,
    },
    run: {
      id: 'run', projectId: 'xtrade', scheduledAt: at, createdAt: at,
      status: 'completed', trigger: 'manual', totalCount: 1, terminalCount: 1,
      succeededCount: 1, capturedCount: 1, resultVersion: 1, deadlineAt: at, expiresAt: 0,
      snapshot: {
        projectName: 'XTrade',
        brand: { id: 'xtrade', name: 'XTrade', domains: ['xtrade.com'], aliases: [] },
        competitors: [], prompts: [prompt], country: 'IT', language: 'en', timezone: 'UTC',
        generationModel: 'saved-model', extractionModel: 'saved-model',
        parserVersion: 'test', configVersion: 1, provider: 'openai',
      },
    },
    answer: {
      providerResponseId: 'response', model: 'saved-model', status: 'completed',
      blocks: [{ id: 'answer', text: 'A saved answer.' }], text: 'A saved answer.',
      citations: [], sources: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, createdAt: at, raw,
    },
    analysis: null,
  };
}

describe('presentation scenario disclosure', () => {
  it('identifies simulated answers and rankings and preserves the original-record distinction', () => {
    const html = renderToStaticMarkup(<PresentationScenarioNotice demo={{
      ...demo,
      presentation: {
        label: 'XTrade visibility scenario',
        targetRank: 8,
        mentionCount: 8,
        reportingOnly: true,
      },
    }} />);

    expect(html).toContain('aria-label="Illustrative scenario"');
    expect(html).toContain('Illustrative scenario · XTrade visibility scenario');
    expect(html).toContain('These answers and rankings are simulated. Original scan records are preserved.');
  });

  it('does not identify real results or ordinary demos as this scenario', () => {
    expect(renderToStaticMarkup(<PresentationScenarioNotice />)).toBe('');
    expect(renderToStaticMarkup(<PresentationScenarioNotice demo={demo} />)).toBe('');
  });

  it('keeps the scenario disclosure visible inside an answer drawer and avoids provider-capture claims', () => {
    const html = renderToStaticMarkup(<ResponseDetailContent data={answerDetail({
      illustrative: true,
      presentation: { label: 'XTrade visibility scenario', reportingOnly: true },
    })} />);

    expect(html).toContain('Illustrative scenario · XTrade visibility scenario');
    expect(html).toContain('Illustrative answer');
    expect(html).toContain('This answer, its ranking and its sentiment are simulated');
    expect(html).toContain('Original provider answers and scan records are preserved.');
    expect(html).not.toContain('Original answer');
    expect(html).not.toContain('Captured from the');
    expect(html).not.toContain('sources returned by the API');
  });

  it.each([null, 'original', { demo: true }, { illustrative: false }])(
    'preserves original answer attribution without an explicit illustrative flag (%j)', (raw) => {
      const html = renderToStaticMarkup(<ResponseDetailContent data={answerDetail(raw)} />);

      expect(html).toContain('Original answer');
      expect(html).toContain('Captured from the');
      expect(html).not.toContain('Illustrative scenario');
      expect(html).not.toContain('Illustrative answer');
    },
  );

  it('still discloses an illustrative answer if its optional presentation label is malformed', () => {
    const html = renderToStaticMarkup(<ResponseDetailContent data={answerDetail({
      illustrative: true, presentation: { label: 8 },
    })} />);

    expect(html).toContain('Illustrative scenario · Simulated visibility example');
    expect(html).toContain('Illustrative answer');
    expect(html).not.toContain('Captured from the');
  });
});
