import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ResponseDetail } from '@citevia/core';
import { ResponseDetailContent } from './ResponseDrawer';

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

describe('Answer attribution', () => {
  it.each([{ demo: true }, { illustrative: true, presentation: { label: 'XTrade visibility scenario' } }])(
    'keeps account setup labels and provider-capture claims out of generated answers', (raw) => {
      const html = renderToStaticMarkup(<ResponseDetailContent data={answerDetail(raw)} />);
      expect(html).toContain('A saved answer.');
      expect(html).toContain('Retrieved sources');
      expect(html).not.toMatch(/illustrative|simulated|scenario|original answer|captured from the|sources returned by the API/i);
    },
  );

  it.each([null, 'original', { illustrative: false }])('identifies saved provider answers', (raw) => {
    const html = renderToStaticMarkup(<ResponseDetailContent data={answerDetail(raw)} />);
    expect(html).toContain('Original answer');
    expect(html).toContain('Captured from the');
  });
});
