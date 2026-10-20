import { describe, it, expect } from 'vitest';
import {
  buildSummary,
  domainForUrl,
  emptyMetrics,
  metricsFromResults,
  nextWeeklyScan,
  normalizeUrl,
  sameCohort,
} from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';

async function fixture() {
  const repository = new MemoryRepository(),
    artifacts = new MemoryArtifacts(),
    queue = new MemoryQueue();
  const project = newProject({
    prompts: [
      'Which analytics tools should I compare?',
      'What tools offer clear reporting?',
    ],
  });
  await repository.saveProject(project, null);
  const scanner = new Scanner({
    repository,
    artifacts,
    queue,
    provider: new FixtureProvider(),
  });
  await scanner.handle({
    kind: 'kickoff',
    projectId: project.id,
    scheduledAt: new Date().toISOString(),
    trigger: 'manual',
  });
  while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
  const run = (await repository.listRuns(project.id))[0],
    results = await repository.listResults(project.id, run.id);
  const details = await Promise.all(
    results.map(async (result) => ({
      result,
      answer: await artifacts.get<any>(result.captureKey!),
      analysis: await artifacts.get<any>(result.analysisKey!),
    })),
  );
  return { repository, artifacts, queue, project, run, results, details };
}
describe('evidence-based metrics', () => {
  it('distinguishes missing measurements from measured absence', () => {
    expect(emptyMetrics().visibility.value).toBeNull();
    const result: any = {
      status: 'succeeded',
      capturedAt: '2026-10-19',
      target: {
        mentioned: false,
        sentiment: 'not_applicable',
        explicitRank: null,
      },
    };
    const failed: any = { status: 'failed_collection' };
    expect(metricsFromResults([result, failed]).visibility).toEqual({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
    expect(metricsFromResults([result, failed]).averageRank.value).toBeNull();
  });
  it('does not equate first mention position with recommendation rank', () => {
    const result: any = {
      status: 'succeeded',
      target: {
        mentioned: true,
        sentiment: 'neutral',
        explicitRank: null,
        mentionOrder: 1,
      },
    };
    expect(metricsFromResults([result]).ranked).toBe(0);
    expect(metricsFromResults([result]).visibility.value).toBe(100);
  });
  it('counts all citations but distinct answers for coverage and preserves meaningful query parameters', async () => {
    const f = await fixture(),
      a = f.details[0];
    a.answer.citations = [
      {
        ...a.answer.citations[0],
        url: 'https://www.publisher.co.uk/story?id=1&utm_source=test',
      },
      {
        ...a.answer.citations[0],
        id: 'duplicate',
        url: 'https://www.publisher.co.uk/story?id=1',
      },
      {
        ...a.answer.citations[0],
        id: 'second-url',
        url: 'https://www.publisher.co.uk/story?id=2',
      },
    ];
    f.details[1].answer.citations = [];
    const summary = buildSummary(f.run, f.results, f.details);
    expect(summary.metrics.citations).toBe(3);
    expect(summary.domains[0]).toMatchObject({
      domain: 'publisher.co.uk',
      answerCount: 1,
      citationCount: 3,
      uniqueUrlCount: 2,
      coverage: 50,
      promptCount: 1,
      usedPercent: 150,
      avgCitations: 3,
      firstSeenAt: a.answer.createdAt,
      lastSeenAt: a.answer.createdAt,
    });
    expect(summary.urls).toHaveLength(2);
  });
  it('keeps citations available after extraction failure without inflating analysis count', async () => {
    const f = await fixture();
    f.results[0].status = 'failed_extraction';
    f.details[0].result = f.results[0];
    const summary = buildSummary(f.run, f.results, f.details);
    expect(summary.metrics.captured).toBe(2);
    expect(summary.metrics.analyzed).toBe(1);
    expect(summary.metrics.citations).toBeGreaterThan(0);
  });
  it('excludes invalid collection checkpoints from source denominator', async () => {
    const f = await fixture();
    delete f.details[0].result.capturedAt;
    f.details[0].result.status = 'failed_collection';
    expect(buildSummary(f.run, f.results, f.details).metrics.captured).toBe(1);
  });
  it('retains consulted sources without counting them as citations', async () => {
    const f = await fixture();
    const summary = buildSummary(f.run, f.results, f.details);
    expect(
      summary.consultedDomains.some((s) => s.domain === 'research.example'),
    ).toBe(true);
    expect(summary.domains.some((s) => s.domain === 'research.example')).toBe(
      false,
    );
  });
  it('flags changed prompt versions and models as different cohorts', async () => {
    const f = await fixture(),
      changed = structuredClone(f.run.snapshot);
    expect(sameCohort(changed, f.run.snapshot)).toBe(true);
    changed.prompts[0].version++;
    expect(sameCohort(changed, f.run.snapshot)).toBe(false);
  });
  it('groups only successful measurements by the frozen prompt section, topic and branding', async () => {
    const f = await fixture();
    f.run.snapshot.prompts[0].stage = 'prefer';
    f.run.snapshot.prompts[0].topic = 'Fees';
    f.run.snapshot.prompts[0].branded = true;
    f.run.snapshot.prompts[1].stage = 'trust';
    f.results[1].status = 'failed_extraction';
    const summary = buildSummary(f.run, f.results, f.details);
    expect(summary.reportingVersion).toBe(2);
    expect(summary.groups.stages.find((s) => s.key === 'prefer')).toMatchObject(
      { promptCount: 1, metrics: { analyzed: 1 } },
    );
    expect(summary.groups.stages.find((s) => s.key === 'trust')).toMatchObject({
      promptCount: 1,
      metrics: { analyzed: 0, visibility: { value: null } },
    });
    expect(
      summary.groups.branding.find((s) => s.key === 'branded')?.metrics
        .analyzed,
    ).toBe(1);
  });
});
describe('URL handling and scheduling', () => {
  it('rejects executable URLs and credentials while preserving content identity', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('https://a:b@example.com')).toBeNull();
    expect(
      normalizeUrl('https://EXAMPLE.com/a?variant=b&utm_campaign=a#part'),
    ).toBe('https://example.com/a?variant=b');
    expect(domainForUrl('https://news.example.co.uk/a')).toBe('example.co.uk');
  });
  it('keeps Monday06 local across Cyprus daylight-saving transition', () => {
    expect(
      nextWeeklyScan('Asia/Nicosia', new Date('2026-10-19T04:00:00Z')),
    ).toBe('2026-10-26T04:00:00.000Z');
    expect(
      nextWeeklyScan('Asia/Nicosia', new Date('2026-10-18T12:00:00Z')),
    ).toBe('2026-10-19T03:00:00.000Z');
  });
});
