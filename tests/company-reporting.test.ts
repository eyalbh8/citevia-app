import { describe, expect, it } from 'vitest';
import {
  reportingCompanies,
  reportingCitations,
  type Analysis,
  type CapturedAnswer,
  type RunSnapshot,
} from '@citevia/core';
import { newProject } from './fixtures/scanner.js';

describe('iGEO company and source projections', () => {
  it('preserves all company ranks, unknown sentiment and evidence-linked citation occurrences', () => {
    const project = newProject(),
      snapshot: RunSnapshot = {
        ...project,
        projectName: project.name,
        configVersion: 1,
      };
    const text = 'OtherCo leads. Northstar is useful.';
    const evidence = (start: number, end: number) => ({
      blockId: 'b',
      start,
      end,
      quote: text.slice(start, end),
    });
    const answer: CapturedAnswer = {
      providerResponseId: 'native',
      model: 'model',
      status: 'completed',
      blocks: [{ id: 'b', text }],
      text,
      citations: [
        {
          id: 'c1',
          blockId: 'b',
          start: 15,
          end: text.length,
          title: 'Article',
          url: 'https://publisher.co.uk/article',
        },
        {
          id: 'c2',
          blockId: 'b',
          start: null,
          end: null,
          title: 'Unknown range',
          url: 'https://publisher.co.uk/another',
        },
      ],
      sources: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      createdAt: project.createdAt,
      raw: {},
    };
    const analysis: Analysis = {
      model: 'model',
      parserVersion: snapshot.parserVersion,
      createdAt: project.createdAt,
      usage: answer.usage,
      companies: [
        { name: 'OtherCo', rank: 1, evidence: evidence(0, 7) },
        { name: 'Northstar', rank: 2, evidence: evidence(15, 24) },
      ],
      brands: [
        {
          brandId: 'target',
          mentioned: true,
          appearanceRank: 2,
          explicitRank: null,
          mentionOrder: 1,
          sentiment: 'positive',
          evidence: [evidence(15, 24)],
          rankEvidence: null,
          sentimentEvidence: evidence(15, text.length),
        },
      ],
    };
    const companies = reportingCompanies(analysis, snapshot, answer);
    expect(companies).toHaveLength(2);
    expect(companies[0]).toMatchObject({
      company: 'OtherCo',
      rank: 1,
      feel: 'unknown',
      sentimentScore: null,
      company_site_url: null,
      sources: [],
      tracked: false,
    });
    expect(companies[1]).toMatchObject({
      company: 'Northstar',
      rank: 2,
      sentimentScore: 100,
      sources: [{ id: 'c1', domain: 'publisher.co.uk' }],
    });
    expect(companies[1].sources).toHaveLength(1);
    expect(reportingCitations(answer)).toHaveLength(2);
    expect(answer.citations[0]).not.toHaveProperty('domain');
  });
});
