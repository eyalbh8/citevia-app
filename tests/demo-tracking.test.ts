import { describe, expect, it, vi } from 'vitest';
import {
  citationMeasurement,
  matchesMonitoringFilters,
  type Analysis,
  type CapturedAnswer,
  type MentionAnswer,
  type MentionsSummary,
  type Project,
  type PromptResult,
  type ScanRun,
  type TrackingDetail,
} from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { createScenarioTracking } from '../packages/storage/src/demo-tracking.js';
import { monitoringRoute } from '../apps/api/src/monitoring.js';
import { buildNayaxDemo, enrollNayaxBlogs, refreshNayaxAccount } from '../scripts/create-nayax-demo.js';
import { newProject } from './fixtures/scanner.js';

const url = 'https://www.nayax.com/blog/best-selling-vending-machine-items/';
function fixture() {
  const project: Project = {
    ...newProject({ id: 'nayax', brand: 'Nayax', domain: 'nayax.com', prompts: ['Which vending payment platforms work best?'] }),
    demo: {
      version: 1, source: 'igeo-nayax', anchorDate: '2026-10-23',
      startDate: '2026-04-23', endDate: '2027-04-23',
      sourceAccountId: 'source-nayax', sourceCopiedAt: '2026-10-23T00:00:00.000Z',
      trackedUrls: [{ url, title: 'Best Products to Sell in Vending Machines 2026', publishedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-04T00:00:00.000Z' }],
    },
  };
  const sample = (id: string, at: string, provider: 'openai' | 'gemini' = 'openai') => {
    const prompt = project.prompts[0];
    const run: ScanRun = {
      projectId: project.id, id, scheduledAt: at, createdAt: at, status: 'completed', trigger: 'scheduled',
      snapshot: { projectName: project.name, brand: project.brand, competitors: [], prompts: [prompt],
        country: 'US', language: 'en', timezone: 'UTC', provider, generationModel: 'test', extractionModel: 'test', parserVersion: project.parserVersion, configVersion: 1 },
      totalCount: 1, terminalCount: 1, succeededCount: 1, capturedCount: 1, resultVersion: 1, deadlineAt: at, expiresAt: 2e9,
    };
    const target = { brandId: project.brand.id, mentioned: true, appearanceRank: 1, explicitRank: null,
      mentionOrder: 1, sentiment: 'positive' as const,
      evidence: [{ blockId: 'b1', quote: 'Nayax', start: 0, end: 5 }], rankEvidence: null, sentimentEvidence: null };
    const result: PromptResult = { projectId: project.id, runId: id, promptId: prompt.id, responseId: `${id}~${prompt.id}`,
      prompt, status: 'succeeded', version: 1, attempts: 0, captureKey: `captures/${id}`, analysisKey: `analyses/${id}`,
      target, citationCount: 2, sourceCount: 1, capturedAt: at, expiresAt: 2e9 };
    const answer: CapturedAnswer = { provider, providerResponseId: id, model: 'test', status: 'completed', text: 'Nayax leads.',
      blocks: [{ id: 'b1', text: 'Nayax leads.' }],
      citations: [
        { id: 'c1', blockId: 'b1', url: `${url}?utm_source=chatgpt`, title: 'Best products', start: 0, end: 5 },
        { id: 'c2', blockId: 'b1', url: `${url}#options`, title: 'Best products', start: null, end: null },
        { id: 'other', blockId: 'b1', url: 'https://other.example/blog/', title: 'Other source', start: null, end: null },
      ],
      sources: [], createdAt: at, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, raw: {} };
    const analysis: Analysis = { brands: [target], parserVersion: project.parserVersion, model: 'test', createdAt: at, usage: answer.usage };
    return { run, result, answer, analysis };
  };
  const samples = [sample('before', '2026-05-03T10:00:00.000Z'), sample('after', '2026-05-05T10:00:00.000Z'), sample('gemini', '2026-05-08T10:00:00.000Z', 'gemini')];
  const history = vi.fn(() => ({ runs: samples.map((item) => item.run), results: samples.map((item) => item.result) }));
  const evidence = vi.fn((run: ScanRun) => samples.find((item) => item.run.id === run.id)!);
  return { project, samples, history, evidence };
}

describe('virtual tracked URL evidence', () => {
  it('uses stable native URL identities, deduplicates tracking variants and retains metadata', () => {
    const { project, history, evidence } = fixture();
    project.demo!.trackedUrls!.push({ ...project.demo!.trackedUrls![0], url: `${url}?utm_source=test` },
      { url: 'javascript:alert(1)', title: 'Invalid', publishedAt: '2026-05-01T00:00:00.000Z' });
    const first = createScenarioTracking(project, { history, evidence }).listTrackedUrls();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ projectId: 'nayax', url, contentType: 'BLOG', active: true, title: project.demo!.trackedUrls![0].title });
    expect(first[0].id).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
    expect(createScenarioTracking(project, { history, evidence }).listTrackedUrls()).toEqual(first);
    expect(history).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
  });

  it('derives appearances and native citations from exactly the displayed capture evidence', () => {
    const { project, samples, history, evidence } = fixture();
    const adapter = createScenarioTracking(project, { history, evidence });
    const matches = adapter.listTrackingMatches();
    expect(matches.map((match) => match.capture.runId)).toEqual(['gemini', 'after']);
    for (const match of matches) {
      const source = samples.find((item) => item.run.id === match.capture.runId)!;
      const native = citationMeasurement(source.result, source.run, source.answer, source.analysis)!;
      expect(match.capture).toEqual(native.capture);
      expect(match.evidence).toEqual(native.evidence[0]);
      expect(match.evidence.nativeCount).toBe(2);
      expect(match.evidence.appearances).toBeGreaterThan(0);
    }
    expect(adapter.listTrackingMatches(adapter.listTrackedUrls()[0].id)).toEqual(matches);
    expect(adapter.listTrackingMatches('unknown-id')).toEqual([]);
    expect(history).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledTimes(2);
    const filtered = matches.filter((match) => matchesMonitoringFilters(match.capture.prompt, match.capture.provider, match.capture.country,
      { providers: ['gemini'], region: 'US', tag: '', branded: '', intent: '', search: '' }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].capture.runId).toBe('gemini');
  });

  it('respects publication dates, enrollment periods and excluded or incomplete runs', () => {
    const { project, samples, history, evidence } = fixture();
    project.demo!.trackedUrls![0].trackingPeriods = [{ start: '2026-05-04T00:00:00.000Z', end: '2026-05-07T00:00:00.000Z' }];
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches().map((match) => match.capture.runId)).toEqual(['after']);
    project.demo!.trackedUrls![0].publishedAt = '2026-05-06T00:00:00.000Z';
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches()).toEqual([]);
    project.demo!.trackedUrls![0].publishedAt = '2026-05-01T00:00:00.000Z';
    delete project.demo!.trackedUrls![0].trackingPeriods;
    samples[1].run.reportingExcludedAt = '2026-05-09T00:00:00.000Z';
    samples[2].run.status = 'running';
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches()).toEqual([]);
  });

  it('does no capture work for an empty configuration or an unknown tracked URL', () => {
    const { project, history, evidence } = fixture();
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches('unknown-id')).toEqual([]);
    delete project.demo!.trackedUrls;
    const empty = createScenarioTracking(project, { history, evidence });
    expect(empty.listTrackedUrls()).toEqual([]);
    expect(empty.listTrackingMatches()).toEqual([]);
    expect(history).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
  });

  it('can skip unrelated captures without changing native evidence measurements', () => {
    const { project, history, evidence, samples } = fixture();
    samples[2].answer.citations = samples[2].answer.citations.filter((citation) => citation.id === 'other');
    const citations = vi.fn((run: ScanRun) => samples.find((item) => item.run.id === run.id)!.answer.citations);
    const prefixed = createScenarioTracking(project, { history, evidence, citations }).listTrackingMatches();
    expect(prefixed.map((match) => match.capture.runId)).toEqual(['after']);
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(citations).toHaveBeenCalledTimes(2);
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches()).toEqual(prefixed);
  });

  it.each(['igeo-dr-roof', 'igeo-nayax', 'website-demo'] as const)('builds and caches only requested %s URL evidence until the whole catalog is needed', (source) => {
    const { project, history, evidence, samples } = fixture();
    project.demo!.source = source;
    const otherUrl = 'https://other.example/blog/';
    project.demo!.trackedUrls!.push({ url: otherUrl, title: 'Another enrolled source',
      publishedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-04T00:00:00.000Z' });
    samples[1].answer.citations = samples[1].answer.citations.filter(citation => citation.url === otherUrl);
    samples[2].answer.citations = samples[2].answer.citations.filter(citation => citation.url !== otherUrl);
    const citations = vi.fn((run: ScanRun) => samples.find(item => item.run.id === run.id)!.answer.citations);
    const adapter = createScenarioTracking(project, { history, evidence, citations });
    const [first, other] = adapter.listTrackedUrls();
    const firstMatches = adapter.listTrackingMatches(first.id);
    expect(firstMatches.map(match => match.capture.runId)).toEqual(['gemini']);
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(evidence.mock.calls[0][0].id).toBe('gemini');
    expect(history).toHaveBeenCalledWith('2026-05-04T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    expect(adapter.listTrackingMatches(first.id)).toEqual(firstMatches);
    expect(evidence).toHaveBeenCalledTimes(1);
    const otherMatches = adapter.listTrackingMatches(other.id);
    expect(otherMatches.map(match => match.capture.runId)).toEqual(['after']);
    expect(evidence).toHaveBeenCalledTimes(2);
    const all = adapter.listTrackingMatches();
    expect(all.filter(match => match.trackedUrlId === first.id)).toEqual(firstMatches);
    expect(all.filter(match => match.trackedUrlId === other.id)).toEqual(otherMatches);
    expect(adapter.listTrackingMatches(first.id)).toEqual(firstMatches);
    expect(evidence).toHaveBeenCalledTimes(4);
    expect(history).toHaveBeenCalledTimes(3);
  });

  it('derives the same Nayax measurements from scoped or full-catalog reads and leaves ordinary projects unchanged', () => {
    const { project, history, evidence } = fixture();
    const adapter = createScenarioTracking(project, { history, evidence });
    const selected = adapter.listTrackingMatches(adapter.listTrackedUrls()[0].id);
    expect(selected).toHaveLength(2);
    expect(evidence).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledWith('2026-05-04T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    expect(adapter.listTrackingMatches()).toEqual(selected);
    expect(history).toHaveBeenCalledWith('2026-04-23T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    expect(history).toHaveBeenCalledTimes(2);
    delete project.demo;
    expect(createScenarioTracking(project, { history, evidence }).listTrackingMatches()).toEqual([]);
    expect(history).toHaveBeenCalledTimes(2);
  });
});

const blogs = [
  ['best-selling-vending-machine-items', 'Best Products to Sell in Vending Machines 2026'],
  ['payment-system-for-vending-business', 'How to Choose the Right Payment System for Your Vending Business'],
  ['vending-machine-inventory-management', 'Vending Machine Inventory Management'],
  ['how-to-start-a-vending-machine-business-your-journey-best-practices-and-tips', 'How to Start a Vending Machine Business'],
  ['how-to-build-a-successful-cashless-vending-business', 'How to Start a Vending Business in 10 Simple Steps'],
  ['the-benefits-of-remote-management-for-vending-machines-how-nayaxs-solution-can-help', 'The Benefits of Remote Management for Vending Machines'],
  ['how-to-grow-your-business-with-nayaxs-vending-machine-management-app', 'How to Grow Your Business with Nayax’s Vending Machine Management App'],
  ['the-benefits-of-using-a-vending-machine-inventory-picklist-in-moma-2-0', 'Improve Your Vending Management with MoMa 2.0’s Inventory Picklist'],
].map(([slug, title]) => ({ url: `https://www.nayax.com/blog/${slug}/`, title, sourcePublishedAt: '2024-01-01T00:00:00.000Z' }));

function account() {
  return buildNayaxDemo({
    brand: { name: 'Nayax', aliases: [], domains: ['nayax.com'] },
    competitors: ['Cantaloupe', 'Ingenico', 'PayRange', 'Adyen', 'Worldpay', 'Clover', 'PayPal', 'SumUp'].map((name) => ({ name, aliases: [], domains: [`${name.toLowerCase()}.com`] })),
    prompts: Array.from({ length: 50 }, (_, index) => ({ text: `Which cashless payment platform fits unattended retail use case ${index + 1}?`, stage: 'understand' })),
    brandbook: { companyCountry: 'US', language: 'en' },
    samples: [{ text: 'Nayax provides payment acceptance and remote management for unattended retail.', citations: [{ url: 'https://www.nayax.com/business_type/vending/', title: 'Vending payment systems' }] }],
  }, '2026-10-23', '2026-10-23T12:00:00.000Z');
}

describe('Nayax tracking integration', () => {
  it('refreshes only account metadata and preserves a compact, idempotent enrollment catalog', async () => {
    const project = account(), repository = new MemoryRepository();
    project.name = 'Nayax Demo';
    project.prompts[0].tags = ['Demo', 'Priority'];
    await repository.saveProject(project, null);
    const preview = await refreshNayaxAccount(repository, blogs);
    expect(preview).toMatchObject({ status: 'preview', name: 'Nayax', trackedUrls: 8, paidCalls: 0 });
    expect((await repository.getProject(project.id))!.name).toBe('Nayax Demo');
    await refreshNayaxAccount(repository, blogs, true, new Date('2026-10-23T12:00:00.000Z'));
    const saved = (await repository.getProject(project.id))!;
    expect(saved.name).toBe('Nayax');
    expect(saved.prompts[0].tags).toEqual(['Priority']);
    expect(saved.demo!.trackedUrls).toEqual(enrollNayaxBlogs(project, blogs));
    expect(new Set(saved.demo!.trackedUrls!.map((entry) => entry.createdAt)).size).toBe(2);
    expect(saved.demo!.trackedUrls!.map((entry) => entry.url)).toEqual(blogs.map((blog) => blog.url));
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(100_000);
    expect(await refreshNayaxAccount(repository, blogs, true)).toMatchObject({ status: 'unchanged' });
    expect(await repository.listTrackedUrls(project.id)).toEqual([]);
    expect(await repository.listTrackingMatches(project.id)).toEqual([]);
    expect(await repository.listRuns(project.id)).toEqual([]);
  });

  it('reconciles scoped popup counts, tracking details and captured answer evidence without pre-enrollment sightings', async () => {
    const project = account(), repository = new MemoryRepository();
    project.demo!.trackedUrls = enrollNayaxBlogs(project, blogs);
    await repository.saveProject(project, null);
    const runtime = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, () => new Date('2026-10-23T12:00:00.000Z'));
    const urls = await runtime.repository.listTrackedUrls(project.id), matches = await runtime.repository.listTrackingMatches(project.id);
    const enrollment = new Map(urls.map((entry) => [entry.id, entry.createdAt]));
    expect(matches.length).toBeGreaterThan(100);
    expect(matches.every((match) => match.capture.capturedAt >= enrollment.get(match.trackedUrlId)!)).toBe(true);
    const query = 'days=custom&start=2026-04-23&end=2027-04-23&providers=gemini&region=US&branded=false';
    const call = async <T,>(tail: string, params = query): Promise<T> => {
      const response = await monitoringRoute(runtime, project, tail, new Request(`http://test/${tail}?${params}`), new Date('2026-10-23T12:00:00.000Z'), (request) => request.json());
      expect(response?.status).toBe(200);
      return response!.json() as Promise<T>;
    };
    const summary = await call<MentionsSummary>('mentions/summary');
    const allProviders = await call<MentionsSummary>('mentions/summary', query.replace('&providers=gemini', ''));
    expect(allProviders.providers).toHaveLength(3);
    expect(new Set(allProviders.providers.map((provider) => JSON.stringify(provider.points))).size).toBe(3);
    expect(new Set(allProviders.providers.map((provider) => provider.count)).size).toBe(3);
    expect(summary.markers).toHaveLength(2);
    expect(summary.markers.every((marker) => marker.items.length === 4)).toBe(true);
    for (const marker of summary.markers) {
      for (const item of marker.items) {
        const detail = await call<TrackingDetail>(`tracked-urls/${item.id}`);
        const scoped = matches.filter((match) => match.trackedUrlId === item.id && match.capture.provider === 'gemini');
        expect(item.appearances).toBe(scoped.reduce((total, match) => total + match.evidence.appearances, 0));
        expect(item.appearances).toBe(detail.row.periodAppearances);
        expect(detail.row.matchingAnswers).toBe(scoped.length);
        expect(detail.row.nativeCitations).toBe(scoped.reduce((total, match) => total + match.evidence.nativeCount, 0));
        expect(item.appearances).toBeGreaterThan(0);
      }
    }
    const tracked = urls[0];
    const answers = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${tracked.id}/answers`, `${query}&pageSize=25`);
    const scoped = matches.filter((match) => match.trackedUrlId === tracked.id && match.capture.provider === 'gemini');
    expect(answers.total).toBe(scoped.length);
    expect(answers.items.length).toBe(25);
    for (const answer of answers.items) {
      const match = scoped.find((entry) => entry.capture.responseId === answer.responseId)!;
      expect(answer.provider).toBe('gemini');
      expect(answer.date >= tracked.createdAt).toBe(true);
      const result = (await runtime.repository.getResult(project.id, match.capture.runId, match.capture.promptId))!;
      const run = (await runtime.repository.getRun(project.id, match.capture.runId))!;
      const captured = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      const measured = citationMeasurement(result, run, captured, analysis)!;
      expect(measured.evidence.find((entry) => entry.normalizedUrl === tracked.normalizedUrl)).toEqual(match.evidence);
    }
    const before = await runtime.repository.listPromptHistory(project.id, `${project.demo!.startDate}T00:00:00.000Z`, tracked.createdAt, project.prompts[0].id);
    for (const result of before.results) {
      const captured = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      expect(captured.citations.some((entry) => blogs.some((blog) => blog.url === entry.url))).toBe(false);
    }
    expect(await repository.listTrackedUrls(project.id)).toEqual([]);
    expect(await repository.listTrackingMatches(project.id)).toEqual([]);
    expect(await repository.listRuns(project.id)).toEqual([]);
  }, 30_000);
});
