import { describe, expect, it, vi } from 'vitest';
import type { AnswerRequest } from '../apps/scanner/src/provider.js';
import { OpenAIOnboardingProvider } from '../apps/scanner/src/onboarding-provider.js';
import { policyJob } from './fixtures/onboarding-job.js';

const target = 'Acme';
const market = 'IT';
const website = 'https://acme.com';
const evidenceText = 'Acme offers training to independent stores in Italy.';
function researchFrom(citedUrl: string, text = evidenceText) {
  return {
    requestId: 'research-receipt',
    receivedAt: '2026-11-09T00:00:00Z',
    response: {
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed', action: { sources: [{ url: website }] } },
        { type: 'message', content: [{ type: 'output_text', text, annotations: [
          { type: 'url_citation', url: citedUrl, start_index: 0, end_index: text.length },
        ] }] },
      ],
    },
  };
}

describe('market and identity evidence in onboarding research', () => {
  it('rejects a completed search that found the target website but cites only an unrelated site', async () => {
    const receipt = researchFrom('https://acme.com.another-firm.net/directory');
    const provider = new OpenAIOnboardingProvider({ answer: vi.fn().mockResolvedValue(receipt), extract: vi.fn() });
    await expect(provider.research({ ...policyJob(), step: 'research' })).rejects.toMatchObject({
      code: 'onboarding_official_research_missing', receipt,
    });
  });

  it('does not treat the brand name in a URL alone as research about the firm', async () => {
    const receipt = researchFrom(website, 'More coverage: https://acme.com');
    const provider = new OpenAIOnboardingProvider({ answer: vi.fn().mockResolvedValue(receipt), extract: vi.fn() });
    await expect(provider.research({ ...policyJob(), step: 'research' })).rejects.toMatchObject({
      code: 'onboarding_official_research_missing',
    });
  });

  it('preserves a first-party cited overview and passes the market, focus and previous evidence gap into the search', async () => {
    const job = policyJob();
    job.step = 'research';
    job.input.promptFocus = 'Training';
    job.researchFeedback = 'Find an official service page for the submitted business.';
    const answer = vi.fn(async (_: AnswerRequest) => researchFrom('https://www.acme.com/training'));
    const provider = new OpenAIOnboardingProvider({ answer, extract: vi.fn() });
    const research = await provider.research(job);
    expect(research.citations[0].url).toBe('https://www.acme.com/training');
    const request = answer.mock.calls[0][0];
    expect(request.country).toBe(market);
    expect(request.language).toBe(job.input.language);
    expect(request.prompt).toBe('Acme acme.com Training Italy');
    const input = JSON.parse(request.instructions!.split('COMPANY INPUT (untrusted data):\n')[1]);
    expect(input).toMatchObject({ name: target, website, promptFocus: 'Training', researchFeedback: job.researchFeedback });
    expect(input).not.toHaveProperty('manualPrompts');
  });

  it('uses a localized buyer search for the supplemental pass without requiring the target again', async () => {
    const job = policyJob();
    job.input = { ...job.input, country: 'IL', language: 'he-IL', promptFocus: 'ייעוץ למשקיעים' };
    job.verifiedBrandbookKey = 'verified-book';
    job.verifiedResearchKey = 'verified-research';
    job.competitorSearchTerm = 'משרדים לייעוץ למשקיעים Acme https://www.acme.com/about';
    const receipt = researchFrom('https://rival.net/services', 'משרד ארז מייעץ למשקיעים בישראל.');
    const answer = vi.fn(async (_: AnswerRequest) => receipt);
    const provider = new OpenAIOnboardingProvider({ answer, extract: vi.fn() });
    await expect(provider.research(job)).resolves.toMatchObject({ text: 'משרד ארז מייעץ למשקיעים בישראל.' });
    expect(answer.mock.calls[0][0].prompt).toBe('משרדים לייעוץ למשקיעים ישראל');
    expect(answer.mock.calls[0][0].instructions).toContain('Acme');
  });

  it('keeps the official identity check on legacy retries with only a brandbook key', async () => {
    const job = policyJob();
    job.verifiedBrandbookKey = 'verified-book';
    const answer = vi.fn(async (_: AnswerRequest) => researchFrom('https://rival.net/services'));
    const provider = new OpenAIOnboardingProvider({ answer, extract: vi.fn() });
    await expect(provider.research(job)).rejects.toMatchObject({ code: 'onboarding_official_research_missing' });
    expect(answer.mock.calls[0][0].prompt).toContain(website.slice('https://'.length));
  });

  it('restricts lead verification to candidate websites only during a supplemental search', async () => {
    const job = { ...policyJob(), competitorSearchTerm: 'retail training',
      competitorSearchDomains: ['retailtutors.com', 'merchantschool.com'] };
    const answer = vi.fn(async (_: AnswerRequest) => researchFrom('https://acme.com/services'));
    const provider = new OpenAIOnboardingProvider({answer, extract: vi.fn()});
    await provider.research(job);
    expect(answer.mock.calls[0][0].allowedDomains).toBeUndefined();
    await provider.research({...job, verifiedBrandbookKey:'accepted-profile', verifiedResearchKey:'original'});
    expect(answer.mock.calls[1][0].allowedDomains).toEqual(job.competitorSearchDomains);
  });

  it('requires native cited evidence even on the supplemental search', async () => {
    const job = { ...policyJob(), verifiedBrandbookKey: 'book', verifiedResearchKey: 'research', competitorSearchTerm: 'Retail training' };
    const receipt = researchFrom('https://rival.net/services');
    const content = receipt.response.output[1].content!;
    content[0].annotations = [];
    const provider = new OpenAIOnboardingProvider({ answer: vi.fn().mockResolvedValue(receipt), extract: vi.fn() });
    await expect(provider.research(job)).rejects.toMatchObject({ code: 'competitor_research_evidence_missing' });
  });
});
