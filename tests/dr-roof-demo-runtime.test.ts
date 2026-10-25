import { describe, expect, it } from 'vitest';
import { citationMeasurement, type Analysis, type CapturedAnswer, type DemoConfig, type MentionAnswer, type MentionsSummary,
  type Project, type PromptResult, type ScanProvider, type TrackingDetail, type TrackingRow, type TrafficFilters } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { aggregateScenarioTraffic } from '../packages/storage/src/demo-traffic.js';
import { newProject } from './fixtures/scanner.js';
import { monitoringRoute } from '../apps/api/src/monitoring.js';

const now = () => new Date('2027-04-23T23:59:59.999Z');
const profile = { visibilityAdjustment: -.03, growthCurve: 1.06, trafficScale: .92, monthlyGrowth: .095 };
function project(source: DemoConfig['source'] = 'igeo-dr-roof', numericProfile: DemoConfig['profile'] = profile): Project {
  return {
    ...newProject({ id: source, brand: source === 'igeo-dr-roof' ? 'Dr. Roof' : 'Nayax',
      domain: source === 'igeo-dr-roof' ? 'drroof.com' : 'nayax.com', now: new Date('2026-10-23T00:00:00.000Z') }),
    enabled: false,
    scanProviders: [{ provider: 'openai', model: 'saved-openai' },
      { provider: 'perplexity', model: 'saved-perplexity' }, { provider: 'gemini', model: 'saved-gemini' }],
    demo: {
      version: 1, source, sourceAccountId: 'original-account', sourceCopiedAt: '2026-10-23T00:00:00.000Z',
      anchorDate: '2026-10-23', startDate: '2026-04-23', endDate: '2027-04-23', profile: numericProfile,
      samples: [{ answerText: 'A source excerpt about roofing service.', companies:
        ['GAF', 'Owens Corning', 'CertainTeed', 'IKO', 'Erie Home', 'CentiMark', 'RoofServ', 'Malarkey Roofing Products'] }],
      traffic: { countries: ['US', 'GB'], pages: ['/', '/roof-repair/', '/contact/'] },
    },
  };
}
async function runtimeFor(saved: Project, clock = now) {
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  await repository.saveProject(saved, null);
  return { repository, artifacts, queue, runtime: withDemoRuntime({ repository, artifacts, queue }, clock) };
}

function weeklyRoofingPosts() {
  const saved = project();
  Object.assign(saved.demo!, { startDate: '2026-04-25', anchorDate: '2026-10-25', endDate: '2027-04-25' });
  const current = [
    ['why-regular-roof-inspections-matter-7-repairs-they-can-reveal', 'Why Regular Roof Inspections Matter: 7 Repairs They Can Reveal'],
    ['fix-it-before-it-costs-you-how-timely-roof-repair-protects-home-value', 'Fix It Before It Costs You: How Timely Roof Repair Protects Home Value'],
    ['preventing-roof-repair-issues-a-proactive-homeowners-guide', 'Preventing Roof Repair Issues: A Proactive Homeowner’s Guide'],
  ];
  saved.demo!.trackedUrls = Array.from({ length: 156 }, (_, index) => {
    const week = Math.floor(index / 3), weekday = index % 3;
    const at = new Date(Date.UTC(2026, 3, 27, 8) + (week * 7 + weekday * 2) * 86400000).toISOString();
    const sample = current[index - 75];
    return { url: `https://www.drroof.com/blog/${sample?.[0] || `test-source-roofing-guide-${index + 1}`}/`,
      title: sample?.[1] || `Roof inspection and repair guide ${index + 1}`,
      publishedAt: at, createdAt: at, contentType: 'BLOG' as const };
  });
  return saved;
}
function trafficMonth(year: number, month: number): TrafficFilters {
  const start = new Date(Date.UTC(year, month, 1)).toISOString();
  const end = new Date(Date.UTC(year, month + 1, 1) - 1).toISOString();
  return { period: { start, end, granularity: 'daily', timezone: 'UTC' },
    previous: { start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      end: new Date(Date.UTC(year, month, 1) - 1).toISOString(), granularity: 'daily', timezone: 'UTC' },
    countries: [], providers: [] };
}
function metrics(results: PromptResult[]) {
  const mentioned = results.flatMap(result => result.target?.mentioned ? [result.target] : []);
  return {
    visibility: mentioned.length / results.length,
    sentiment: mentioned.reduce((n, brand) => n + (brand.sentiment === 'positive' ? 100 : 50), 0) / mentioned.length,
    rank: mentioned.reduce((n, brand) => n + brand.appearanceRank!, 0) / mentioned.length,
  };
}

describe('compact Dr. Roof scenario runtime', () => {
  it('keeps original Nayax numeric defaults and explicit defaults identical', async () => {
    const unchanged = project('igeo-nayax');
    delete unchanged.demo!.profile;
    const explicit = structuredClone(unchanged);
    explicit.demo!.profile = { visibilityAdjustment: 0, growthCurve: 1, trafficScale: 1, monthlyGrowth: .1 };
    const first = await runtimeFor(unchanged), second = await runtimeFor(explicit);
    const early = ['2026-04-23T00:00:00.000Z', '2026-04-30T23:59:59.999Z'] as const;
    const base = await first.runtime.repository.listPromptHistory(unchanged.id, ...early);
    expect(await second.runtime.repository.listPromptHistory(explicit.id, ...early)).toEqual(base);
    const initial = base.runs.slice(0, 3).map(run =>
      base.results.filter(result => result.runId === run.id && result.target?.mentioned).length);
    expect(initial).toEqual([21, 17, 14]);
    expect(aggregateScenarioTraffic(unchanged, trafficMonth(2026, 9)))
      .toEqual(aggregateScenarioTraffic(explicit, trafficMonth(2026, 9)));
    expect(aggregateScenarioTraffic(unchanged, trafficMonth(2026, 9)).providers[0].visits).toBe(2000);
  });

  it('varies Dr. Roof modestly and keeps every provider visibility, sentiment and rank monotonic', async () => {
    const drRoof = project(), nayax = project('igeo-nayax');
    delete nayax.demo!.profile;
    const roof = await runtimeFor(drRoof), original = await runtimeFor(nayax);
    const history = await roof.runtime.repository.listPromptHistory(drRoof.id,
      '2026-04-23T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    const baseline = await original.runtime.repository.listPromptHistory(nayax.id,
      '2026-04-23T00:00:00.000Z', '2026-04-30T23:59:59.999Z');
    const groups = new Map<string, PromptResult[]>();
    for (const result of history.results) groups.set(result.runId, [...(groups.get(result.runId) || []), result]);
    const previous = new Map<ScanProvider, ReturnType<typeof metrics>>();
    for (const run of history.runs) {
      const current = metrics(groups.get(run.id)!);
      const prior = previous.get(run.snapshot.provider!);
      if (prior) {
        expect(current.visibility).toBeGreaterThanOrEqual(prior.visibility);
        expect(current.sentiment + 1e-9).toBeGreaterThanOrEqual(prior.sentiment);
        expect(current.rank).toBeLessThanOrEqual(prior.rank);
      } else {
        const reference = metrics(baseline.results.filter(result => result.runId === run.id));
        expect(reference.visibility - current.visibility).toBeGreaterThan(0);
        expect(reference.visibility - current.visibility).toBeLessThanOrEqual(.06);
      }
      previous.set(run.snapshot.provider!, current);
    }
    expect(previous.size).toBe(3);
    expect([...previous.values()].every(value => value.visibility > .75 && value.visibility < 1)).toBe(true);
    const weeks = new Map<string, Set<string>>();
    for (const run of history.runs) {
      const date = new Date(run.scheduledAt), at = date.getTime();
      const monday = new Date(at - ((date.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
      const slots = weeks.get(monday) || new Set<string>();
      slots.add(run.scheduledAt); weeks.set(monday, slots);
    }
    expect([...weeks.values()].slice(1, -1).every(slots => slots.size === 2)).toBe(true);
  });

  it('anchors ChatGPT at 1,840 and preserves consistent monthly growth and dimensions', () => {
    const saved = project();
    const anchor = aggregateScenarioTraffic(saved, trafficMonth(2026, 9));
    expect(anchor.providers.map(value => value.visits)).toEqual([1840, 33, 50, 39, 22, 17]);
    expect(anchor.current).toBe(2001);
    let previous = 0;
    for (let month = 4; month <= 14; month++) {
      const report = aggregateScenarioTraffic(saved, trafficMonth(2026, month));
      expect(report.current).toBeGreaterThan(previous);
      for (const dimension of [report.sources, report.pages, report.locations, report.browsers, report.devices])
        expect(dimension.reduce((n, row) => n + row.visits, 0)).toBe(report.current);
      expect(report.series.reduce((n, row) => n + Object.values(row.values).reduce((sum, visits) => sum + visits, 0), 0))
        .toBe(report.current);
      previous = report.current;
    }
    const next = aggregateScenarioTraffic(saved, trafficMonth(2026, 10));
    expect(next.providers[0].visits).toBe(2015);
    expect(next.previous).toBe(anchor.current);
  });

  it('serves roofing evidence and virtual reports while persisting only the saved configuration', async () => {
    const saved = project(), before = structuredClone(saved);
    const { runtime, repository, artifacts, queue } = await runtimeFor(saved);
    const history = await runtime.repository.listPromptHistory(saved.id,
      '2027-04-01T00:00:00.000Z', '2027-04-23T23:59:59.999Z');
    const result = history.results.find(result => result.target?.sentiment === 'positive')!;
    const answer = await runtime.artifacts.get<CapturedAnswer>(result.captureKey!);
    expect(answer?.text).toContain('local roofing contractors');
    expect(answer?.text).toContain('roof inspections, reliable repairs, and clear warranty coverage');
    expect(answer?.text).not.toMatch(/payment platform|unattended retail|payment acceptance/i);
    expect((await runtime.repository.aggregateTraffic(saved.id, trafficMonth(2026, 9))).current).toBe(2001);
    expect(await repository.listRuns(saved.id)).toEqual([]);
    expect((await repository.listPromptHistory(saved.id, '2026-01-01T00:00:00Z', now().toISOString())).results).toEqual([]);
    expect((await repository.aggregateTraffic(saved.id, trafficMonth(2026, 9))).current).toBe(0);
    expect((await repository.trafficStatus(saved.id)).hasEvents).toBe(false);
    expect(await repository.listTrackedUrls(saved.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
    expect(saved).toEqual(before);
  });

  it('picks up every published weekly post at the first subsequent scenario scan without extra runs', async () => {
    const saved = weeklyRoofingPosts(), asOf = new Date('2026-10-25T12:00:00.000Z');
    const { runtime, repository, artifacts, queue } = await runtimeFor(saved);
    const urls = await runtime.repository.listTrackedUrls(saved.id);
    expect(urls).toHaveLength(156);
    const runs = await runtime.repository.listRuns(saved.id, 1000);
    const times = [...new Set(runs.map(run => run.scheduledAt))].sort();
    const matches = await runtime.repository.listTrackingMatches(saved.id);
    for (const url of urls) {
      const firstScan = times.find(at => at >= url.createdAt && at >= url.publishedAt);
      const eligible = matches.filter(match => match.trackedUrlId === url.id);
      expect(eligible.every(match => match.capture.capturedAt >= url.createdAt && match.capture.capturedAt >= url.publishedAt)).toBe(true);
      if (firstScan && firstScan <= asOf.toISOString()) {
        expect(eligible.some(match => match.capture.mentioned &&
          match.capture.capturedAt >= firstScan && Date.parse(match.capture.capturedAt) < Date.parse(firstScan) + 50_000),
        url.title).toBe(true);
      }
    }
    expect(urls.filter(url => url.publishedAt <= asOf.toISOString())).toHaveLength(78);
    const pending = urls.find(url => url.publishedAt === '2026-10-23T08:00:00.000Z')!;
    expect(matches.filter(match => match.trackedUrlId === pending.id && match.capture.capturedAt <= asOf.toISOString())).toEqual([]);
    expect(matches.filter(match => match.trackedUrlId === pending.id).some(match => match.capture.capturedAt.startsWith('2026-10-26'))).toBe(true);
    const runIds = new Set(runs.map(run => run.id));
    expect(matches.every(match => runIds.has(match.capture.runId))).toBe(true);
    expect(await repository.listRuns(saved.id)).toEqual([]);
    expect(await repository.listTrackingMatches(saved.id)).toEqual([]);
    expect(artifacts.values.size).toBe(0);
    expect(queue.messages).toEqual([]);
  }, 30_000);

  it('shows the current three titled blog markers and reconciles popup citations with native answers', async () => {
    let currentTime = '2026-10-25T12:00:00.000Z';
    const saved = weeklyRoofingPosts(), clock = () => new Date(currentTime);
    const { runtime } = await runtimeFor(saved, clock);
    const call = async <T,>(tail: string): Promise<T> => {
      const response = await monitoringRoute(runtime, saved, tail,
        new Request(`https://test/${tail}?days=7&pageSize=25`), clock(), request => request.json());
      expect(response?.status).toBe(200);
      return response!.json() as Promise<T>;
    };
    const summary = await call<MentionsSummary>('mentions/summary');
    const markers = summary.markers.flatMap(marker => marker.items);
    const current = saved.demo!.trackedUrls!.slice(75, 78);
    expect(markers.map(marker => marker.title).sort()).toEqual(current.map(row => row.title).sort());
    expect(markers.every(marker => marker.contentType === 'BLOG')).toBe(true);
    const list = await call<{ items: TrackingRow[]; total: number }>('tracked-urls');
    expect(list.total).toBe(3);
    expect(list.items.map(row => row.title).sort()).toEqual(current.map(row => row.title).sort());
    const selected = markers.find(marker => marker.appearances > 0)!;
    expect(selected).toBeDefined();
    const detail = await call<TrackingDetail>(`tracked-urls/${selected.id}`);
    const popup = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${selected.id}/answers`);
    expect(detail.row.periodAppearances).toBe(selected.appearances);
    expect(detail.row.matchingAnswers).toBe(popup.total);
    expect(popup.items.length).toBeGreaterThan(0);
    const matches = await runtime.repository.listTrackingMatches(saved.id, selected.id);
    for (const item of popup.items) {
      const match = matches.find(match => match.capture.responseId === item.responseId)!;
      const result = (await runtime.repository.getResult(saved.id, match.capture.runId, match.capture.promptId))!;
      const run = (await runtime.repository.getRun(saved.id, match.capture.runId))!;
      const answer = (await runtime.artifacts.get<CapturedAnswer>(result.captureKey!))!;
      const analysis = (await runtime.artifacts.get<Analysis>(result.analysisKey!))!;
      expect(answer.citations.some(citation => citation.url === selected.url)).toBe(true);
      expect(item.citationCount).toBe(answer.citations.length);
      expect(result.citationCount).toBe(answer.citations.length);
      const evidence = citationMeasurement(result, run, answer, analysis)!.evidence;
      expect(evidence.find(row => row.normalizedUrl === match.evidence.normalizedUrl)).toEqual(match.evidence);
    }
    const pending = markers.find(marker => marker.publishedAt === '2026-10-23T08:00:00.000Z')!;
    expect(pending.appearances).toBe(0);
    const before = await call<TrackingDetail>(`tracked-urls/${pending.id}`);
    const beforeAnswers = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${pending.id}/answers`);
    expect(before.row).toMatchObject({ firstCitedAt: null, lastCitedAt: null,
      status: 'published', appearances: 0, periodAppearances: 0, nativeCitations: 0 });
    expect(beforeAnswers.total).toBe(0);
    currentTime = '2026-10-26T12:00:00.000Z';
    const after = await call<TrackingDetail>(`tracked-urls/${pending.id}`);
    const afterAnswers = await call<{ items: MentionAnswer[]; total: number }>(`tracked-urls/${pending.id}/answers`);
    const afterSummary = await call<MentionsSummary>('mentions/summary');
    const afterMarker = afterSummary.markers.flatMap(marker => marker.items).find(marker => marker.id === pending.id)!;
    expect(after.row.status).toBe('cited');
    expect(after.row.firstCitedAt?.startsWith('2026-10-26T10:00:')).toBe(true);
    expect(after.row.periodAppearances).toBeGreaterThan(0);
    expect(afterMarker.appearances).toBe(after.row.periodAppearances);
    expect(after.row.matchingAnswers).toBe(afterAnswers.total);
    expect(afterAnswers.total).toBeGreaterThan(0);
    expect(afterAnswers.items.every(answer => answer.date >= pending.publishedAt! && answer.date <= currentTime)).toBe(true);
    const projected = await monitoringRoute(runtime, saved, `tracked-urls/${pending.id}`,
      new Request(`https://test/tracked-urls/${pending.id}?days=custom&start=2026-10-19&end=2026-10-26`),
      new Date('2026-10-25T12:00:00.000Z'), request => request.json());
    expect(((await projected!.json()) as TrackingDetail).row.firstCitedAt?.startsWith('2026-10-26')).toBe(true);
  }, 30_000);

  it.each([
    ['visibilityAdjustment', -.21], ['visibilityAdjustment', .21],
    ['growthCurve', 0], ['growthCurve', 2.1], ['trafficScale', 0], ['trafficScale', 2.1],
    ['monthlyGrowth', -.01], ['monthlyGrowth', .26], ['monthlyGrowth', NaN], ['trafficScale', Infinity],
  ] as const)('rejects out-of-bounds %s numeric settings', async (field, value) => {
    const saved = project();
    saved.demo!.profile = { [field]: value };
    const { runtime } = await runtimeFor(saved);
    await expect(runtime.repository.listRuns(saved.id)).rejects.toThrow('Invalid demo numeric profile');
    expect(() => aggregateScenarioTraffic(saved, trafficMonth(2026, 9))).toThrow('Invalid demo numeric profile');
  });
});
