import { describe, it, expect, vi } from 'vitest';
import { JOURNEY_STAGES, type Brandbook, type Prompt } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { OpenAIOnboardingProvider, OnboardingOutputError, portfolioDraftFromPrompts, previousPortfolioDraft, validatePortfolio } from '../apps/scanner/src/onboarding-provider.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
import { verifiedBrandNames } from '../apps/scanner/src/onboarding-evidence.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { testIdentity } from './fixtures/users.js';

function rejected() {
  const draft = { understand: { unbranded: [{text: 'Which providers serve small teams?', intent: 'discovery'}] } };
  return new OnboardingOutputError(new ProviderError('onboarding_duplicate_prompts', 'Questions repeat.', false),
    { response: { status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(draft)}]}] },
      requestId: 'test-response', receivedAt: new Date().toISOString() });
}

async function atPrompts() {
  const runtime = { repository: new MemoryRepository(), artifacts: new MemoryArtifacts(), queue: new MemoryQueue() };
  await runtime.repository.syncUser(testIdentity('owner'));
  const { items: [item] } = await createAccounts(runtime, 'owner', 'recover-portfolio',
    { accounts: [{ name: 'Acme', website: 'https://acme.com', region: 'US', language: 'en', promptFocus: 'Consulting' }] }, new Date(), 10);
  const provider = new FixtureOnboardingProvider();
  const engine = new OnboardingEngine(runtime, provider, async () => {});
  const work = () => engine.handle(item.project.id, item.job.id);
  const saved = () => runtime.repository.getOnboarding(item.project.id, item.job.id);
  await work();
  await work();
  return { runtime, provider, item, saved, work };
}

describe('onboarding portfolio corrections', () => {
  it('preserves focus and research, then runs a new revision after a completed quality rejection', async () => {
    const { provider, saved, work, item } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValueOnce(rejected());
    expect(item.project.promptFocus).toBe('Consulting');
    const first = await saved();
    await work();
    expect(await saved()).toMatchObject({ status: 'queued', step: 'prompts', portfolioRevision: 1, portfolioFeedback: { code: 'onboarding_duplicate_prompts' } });
    await Promise.all([work(), work()]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({portfolioRevision: 1}),
      expect.anything(), expect.anything(),
      [{stage: 'understand', group: 'unbranded', text: 'Which providers serve small teams?', intent: 'discovery'}]);
    expect(generate.mock.calls[1][0].input.promptFocus).toBe('Consulting');
    expect(await saved()).toMatchObject({ step: 'activate', brandbookKey: first?.brandbookKey, researchKey: first?.researchKey });
    expect((await saved())?.promptsKey).toMatch(/prompts-revision-1\.json$/);
  });

  it('repairs only failed generated slots and retains original topics, wording, intent and manual questions', async () => {
    const { item, provider: fixture } = await atPrompts();
    const job = {...item.job, input: {...item.job.input, accountType: 'prospect' as const,
      manualPrompts: [{stage: 'trust' as const, text: 'Who documents accessibility consulting projects?'}]}};
    const book = (await fixture.brandbook(job)).brandbook;
    const original = (await fixture.prompts(job, book)).prompts;
    const draft = portfolioDraftFromPrompts(job, original);
    const sections = Object.fromEntries(JOURNEY_STAGES.map(stage => [stage,
      Object.fromEntries((['branded', 'unbranded'] as const).map(group => [group, draft
        .filter(row => row.stage === stage && row.group === group).map(({text, topic, intent}) => ({text, topic, intent}))]))]));
    const duplicate = structuredClone(sections);
    duplicate.understand.unbranded[1].text = duplicate.understand.unbranded[0].text;
    duplicate.convert.unbranded[0].text = 'What is a broker?';
    const corrected = {repairs: {
      understand_unbranded_2: sections.understand.unbranded[1].text,
      convert_unbranded_1: sections.convert.unbranded[0].text,
    }};
    const receipt = (value: unknown) => ({response: {status:'completed', output: [{type:'message', content:[{type:'output_text', text: JSON.stringify(value)}]}]},
      requestId: 'native', receivedAt: new Date().toISOString()});
    const extract = vi.fn().mockResolvedValueOnce(receipt(duplicate))
      .mockResolvedValueOnce(receipt({repairs:{...corrected.repairs, understand_branded_1: 'Does Acme sell cupcakes?'}}))
      .mockResolvedValueOnce(receipt(corrected));
    const generator = new OpenAIOnboardingProvider({answer: vi.fn(), extract});
    const reject = async (previous?: typeof draft) => {
      try { await generator.prompts(job, book, [], previous); }
      catch (error) {
        expect(error).toBeInstanceOf(OnboardingOutputError);
        if (!previous) expect((error as OnboardingOutputError).code).toBe('onboarding_duplicate_prompts');
        return previousPortfolioDraft((error as OnboardingOutputError).receipt);
      }
      throw new Error('Expected rejected output');
    };
    const first = await reject();
    expect(first.filter(row => row.rewrite).map(row => row.text)).toEqual([
      duplicate.understand.unbranded[1].text, duplicate.convert.unbranded[0].text,
    ]);
    const afterMalformedRevision = await reject(first);
    expect(afterMalformedRevision).toEqual(first);
    const result = await generator.prompts(job, book, [], afterMalformedRevision);
    expect(result.prompts.map(({text, stage, topic, intent}) => ({text, stage, topic, intent})))
      .toEqual(original.map(({text, stage, topic, intent}) => ({text, stage, topic, intent})));
    const repairRequest = extract.mock.calls[1][0];
    expect(repairRequest.schemaName).toBe('buyer_question_repair');
    expect(repairRequest.schema.properties.repairs.required).toEqual(['understand_unbranded_2', 'convert_unbranded_1']);
    expect(repairRequest.input.slots.map((slot: {reason:string}) => slot.reason)).toEqual([
      expect.stringMatching(/duplicate/iu), expect.stringMatching(/definition/iu),
    ]);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('rejects a copied editorial rewrite and keeps an accepted later row when a repair duplicates it', async () => {
    const { item, provider: fixture } = await atPrompts();
    const job = {...item.job, input: {...item.job.input, accountType: 'prospect' as const}};
    const book = (await fixture.brandbook(job)).brandbook;
    const original = (await fixture.prompts(job, book)).prompts;
    const all = portfolioDraftFromPrompts(job, original);
    const index = all.findIndex(row => row.stage === 'understand' && row.group === 'unbranded');
    const draft = all.map((row, i) => ({...row, rewrite: i === index, reason: i === index ? 'Use a concrete buyer need.' : undefined}));
    const receipt = (text: string) => ({response: {status: 'completed', output: [{type: 'message', content: [{
      type: 'output_text', text: JSON.stringify({repairs: {understand_unbranded_1: text}}),
    }]}]}, requestId: 'repair', receivedAt: new Date().toISOString()});
    const extract = vi.fn().mockResolvedValueOnce(receipt(draft[index].text + '?'))
      .mockResolvedValueOnce(receipt(draft[index + 1].text));
    const generator = new OpenAIOnboardingProvider({answer: vi.fn(), extract});
    for (const code of ['onboarding_unchanged_repair', 'onboarding_duplicate_prompts']) {
      try { await generator.prompts(job, book, [], draft); }
      catch (error) {
        expect(error).toMatchObject({code});
        const corrections = previousPortfolioDraft((error as OnboardingOutputError).receipt);
        expect(corrections.flatMap((row, i) => row.rewrite ? [i] : [])).toEqual([index]);
        continue;
      }
      throw new Error('The rejected slot was accepted');
    }
  });

  it('reuses v10 brand research and gives only the invalid saved portfolio slot to the next revision', async () => {
    const { item, provider, runtime, saved, work } = await atPrompts();
    const pending = (await saved())!;
    const book = (await runtime.artifacts.get<{brandbook: Brandbook}>(pending.brandbookKey!))!;
    await runtime.artifacts.put(pending.brandbookKey!, {...book, receipt: {instructionsVersion: 'citevia-onboarding-v10'}});
    const research = vi.spyOn(provider, 'research');
    await work();
    const queued = (await saved())!;
    const checkpoint = (await runtime.artifacts.get<{prompts: Prompt[]}>(queued.promptsKey!))!;
    const index = checkpoint.prompts.findIndex(row => !row.branded);
    checkpoint.prompts[index].text = 'What is a broker?';
    await runtime.artifacts.put(queued.promptsKey!, checkpoint);
    await work();
    const correction = (await saved())!;
    expect(correction).toMatchObject({step: 'prompts', portfolioRevision: 1, brandbookKey: pending.brandbookKey});
    const received = vi.spyOn(provider, 'prompts');
    await work();
    expect(received).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(),
      expect.arrayContaining([expect.objectContaining({text: 'What is a broker?', rewrite: true})]));
    const draft = (received.mock.calls[0] as unknown[])[3] as {rewrite: boolean}[];
    expect(draft.filter(row => row.rewrite)).toHaveLength(1);
    expect(research).not.toHaveBeenCalled();
    expect(await runtime.repository.listRuns(item.project.id)).toEqual([]);
  });

  it('recognizes natural comparisons by rank or a single superlative in English', async () => {
    const { item, provider: fixture } = await atPrompts();
    const job = {...item.job, input: {...item.job.input, accountType: 'prospect' as const}};
    const book = (await fixture.brandbook(job)).brandbook;
    const generated = (await fixture.prompts(job, book)).prompts;
    const rows = generated.map(({text, stage, topic, intent, branded}) => ({text, stage, topic, intent, branded}));
    const comparison = rows.find(row => row.intent === 'comparison' && !row.branded)!;
    for (const text of [
      'Which copy trading platforms have the lowest minimum deposit?',
      'Copy trading platforms ranked by minimum deposit required',
      'Which brokers have the highest margin rates?',
      'Which trading app has the smallest minimum deposit?',
      'Which trading app is easiest for beginners?',
    ]) {
      comparison.text = text;
      expect(validatePortfolio(job, book, {prompts: rows})).toHaveLength(10);
    }
  });

  it('flags a Spanish prefer slot that labels a single-provider enquiry as a comparison', async () => {
    const { item, provider: fixture } = await atPrompts();
    const job = {...item.job, input: {...item.job.input, accountType: 'prospect' as const,
      name: 'Olmo Capital', country: 'MX', language: 'es-MX'}};
    const book = (await fixture.brandbook(job)).brandbook;
    const rows = [
      ['understand', '¿Qué servicios ofrece Olmo Capital?', true, 'informational'],
      ['understand', '¿Qué brókers ofrecen cuentas demo?', false, 'discovery'],
      ['understand', '¿Dónde puedo comprar acciones de Estados Unidos?', false, 'discovery'],
      ['prefer', '¿Es mejor Olmo Capital o Banco Pino para operar desde México?', true, 'comparison'],
      ['prefer', '¿Qué bróker cobra menos por retirar pesos?', false, 'comparison'],
      ['prefer', 'Busco un bróker para empezar con mil pesos', false, 'commercial'],
      ['trust', '¿Dónde puedo verificar la licencia de un bróker?', false, 'validation'],
      ['trust', '¿Qué brókers publican sus comisiones?', false, 'validation'],
      ['convert', '¿Dónde puedo abrir una cuenta de inversión en pesos?', false, 'transactional'],
      ['convert', 'Brókers para comprar mi primera acción', false, 'commercial'],
    ].map(([stage, text, branded, intent]) => ({stage, text, branded, intent, topic: 'Inversión'}));
    const peers = [{name: 'Banco Pino', aliases: [], domains: []}];
    for (const text of [
      '¿Qué bróker cobra menos por retirar pesos?',
      '¿Qué plataformas de copy trading tienen el depósito mínimo más bajo?',
      'Brókers ordenados por depósito mínimo',
      '¿Qué app de inversión es la más sencilla para principiantes?',
      '¿Qué bróker acepta el depósito inicial más pequeño?',
    ]) {
      rows[4].text = text;
      expect(validatePortfolio(job, book, {prompts: rows}, peers)).toHaveLength(10);
    }
    rows[4].text = '¿Qué brókers permiten retirar pesos o dólares?';
    expect(() => validatePortfolio(job, book, {prompts: rows}, peers)).toThrowError(expect.objectContaining({
      code: 'onboarding_comparison_coverage_invalid', rowIndices: [4],
    }));
  });

  it('bounds paid revisions and keeps the account paused if every complete response fails', async () => {
    const { provider, saved, work, item, runtime } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValue(rejected());
    for (let i = 0; i < 5; i++) await work();
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await saved()).toMatchObject({ status: 'failed', step: 'prompts', automaticPortfolioCorrections: 2 });
    expect((await runtime.repository.getProject(item.project.id))?.enabled).toBe(false);
  });

  it('leaves a rejected editorial revision ready for the existing owner retry at a fresh generation key', async () => {
    const { provider, saved, work, runtime, item } = await atPrompts();
    const receipt = {response:{status:'completed'}, requestId:'review', receivedAt: new Date().toISOString()};
    const review = vi.spyOn(provider, 'review').mockRejectedValue(new OnboardingOutputError(
      new ProviderError('onboarding_editorial_revision', 'Remove a second question.', false), receipt));
    for (let attempt = 0; attempt < 6; attempt++) await work();
    const failed = (await saved())!;
    expect(failed).toMatchObject({status:'failed', step:'prompts', portfolioRevision:3,
      automaticPortfolioCorrections:2, portfolioFeedback:{code:'onboarding_editorial_revision'}});
    expect(failed.promptsKey).toBeUndefined();
    expect(await runtime.artifacts.get(failed.rejectedPortfolioKey!)).toMatchObject({requestId:'review'});
    expect(review).toHaveBeenCalledTimes(3);
    expect(await runtime.repository.listRuns(item.project.id)).toEqual([]);
  });

  it('does not spend again if the rejected response could not be saved', async () => {
    const { provider, saved, work, runtime } = await atPrompts();
    const generate = vi.spyOn(provider, 'prompts').mockRejectedValue(rejected());
    vi.spyOn(runtime.artifacts, 'put').mockRejectedValueOnce(new Error('Storage unavailable'));
    await work();
    await work();
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await saved())?.status).toBe('failed');
  });

  it('only adds alternative names supported by name evidence from the supplied business website', () => {
    const names = verifiedBrandNames('Acme Group', 'https://www.acme.com', {
      names: ['Acme Studio', 'Acme Service', 'E2 Visa', 'Fake Limited'],
      evidence: [
        { field: 'names', quote: 'Our former name was Acme Studio.', url: 'https://acme.com/about' },
        { field: 'keyFeatures', quote: 'An E2 Visa and Acme Service are available.', url: 'https://acme.com/services' },
        { field: 'names', quote: 'Trading as Fake Limited.', url: 'https://acme.com.other.org' },
      ],
    });
    expect(names).toEqual(['Acme Group', 'Acme Studio']);
  });
});
