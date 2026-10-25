import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import { buildDrRoofDemo, createDrRoofDemo, DR_ROOF_DEMO_ID, DR_ROOF_DEMO_PROFILE, DR_ROOF_SOURCE_ACCOUNT_ID } from '../scripts/create-dr-roof-demo.js';
import { monitoringRoute } from '../apps/api/src/monitoring.js';

const source = () => ({
  sourceAccountId: DR_ROOF_SOURCE_ACCOUNT_ID,
  brand: { name: 'Dr. Roof', aliases: ['Dr Roof'], domains: ['drroof.com', 'https://www.facebook.com/DrRoofGA'] },
  competitors: Array.from({ length: 8 }, (_, index) => ({ name: `Source contractor ${index + 1}`, domains: [`contractor-${index + 1}.example`], aliases: [] })),
  prompts: Array.from({ length: 50 }, (_, index) => ({ text: `Which roofing service solves roof problem ${index + 1}?`, topic: 'Roof repair' })),
  brandbook: { about: 'Dr. Roof provides roofing services.', company_country: 'US', language: 'English', key_features: ['Roof repair'] },
  samples: [{ text: 'Dr. Roof repairs roofs in Atlanta.', citations: [{ url: 'https://drroof.com/roof-repair/', title: 'Roof repair' }] }],
  traffic: { pages: ['/', '/roof-repair/'], countries: ['US'], devices: ['mobile'], browsers: ['Chrome'] },
  blogs: Array.from({ length: 156 }, (_, index) => ({ url: `https://www.drroof.com/blog/p.202600${index}/roof-care-${index}/`,
    title: `Saved roofing article ${index + 1}`, sourcePublishedAt: '2026-01-12T00:00:00.000Z', sourceTrackedAt: '2026-02-12T00:00:00.000Z' })),
});
const project = () => buildDrRoofDemo(source(), '2026-10-25', '2026-10-25T10:00:00.000Z');

describe('explicit compact Dr. Roof demo', () => {
  it('keeps source identity, fifty actual questions, source-ordered competitors and modest independent numbers', () => {
    const original = source(), before = structuredClone(original), p = buildDrRoofDemo(original, '2026-10-25', '2026-10-25T10:00:00.000Z');
    expect(original).toEqual(before);
    expect(p.id).toBe(DR_ROOF_DEMO_ID);
    expect(p.name).toBe('Dr. Roof');
    expect(p.brand.domains).toEqual(['drroof.com']);
    expect(p.prompts.map(prompt => prompt.text)).toEqual(original.prompts.map(prompt => prompt.text));
    expect(p.competitors.map(competitor => competitor.name)).toEqual(original.competitors.slice(0, 5).map(competitor => competitor.name));
    expect(p.demo).toMatchObject({ source: 'igeo-dr-roof', sourceAccountId: DR_ROOF_SOURCE_ACCOUNT_ID,
      startDate: '2026-04-25', endDate: '2027-04-25', profile: DR_ROOF_DEMO_PROFILE });
    expect(p.demo?.traffic).toMatchObject(original.traffic);
    expect(p.demo?.samples?.[0]).toMatchObject({ answerText: original.samples[0].text, citations: original.samples[0].citations });
    expect(p.enabled).toBe(false);
    expect(p.scanSchedule?.slotsUtcMinutes).toHaveLength(2);
    expect(p.scanProviders?.map(provider => provider.provider)).toEqual(['openai', 'perplexity', 'gemini']);
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(250000);
  });

  it('rejects another account, an unrelated company and misleading website domains', () => {
    expect(() => buildDrRoofDemo({ ...source(), sourceAccountId: 'another-account' })).toThrow();
    expect(() => buildDrRoofDemo({ ...source(), brand: { ...source().brand, name: 'Another Roofer' } })).toThrow('selected Dr. Roof');
    for (const domain of ['drroof.com.evil.example', 'facebook.com', 'https://drroof.com@evil.example/'])
      expect(() => buildDrRoofDemo({ ...source(), brand: { ...source().brand, domains: [domain] } })).toThrow('official drroof.com');
  });

  it('requires fifty distinct existing questions and five distinct existing competitor names', () => {
    expect(() => buildDrRoofDemo({ ...source(), prompts: Array.from({ length: 50 }, () => source().prompts[0]) })).toThrow('50 distinct source prompts');
    expect(() => buildDrRoofDemo({ ...source(), competitors: Array.from({ length: 5 }, () => source().competitors[0]) })).toThrow('five distinct source competitors');
    expect(() => buildDrRoofDemo({ ...source(), samples: [{ text: '' }] })).toThrow('saved answer excerpt');
  });

  it('infers roofing journey groups without rewriting the original question text', () => {
    const s = source();
    const questions = ['What causes roof leaks?', 'Best roofing contractors in Atlanta?', 'Are roofers licensed and insured?', 'Book a roof repair quote', 'Roof inspection and warranty options'];
    questions.forEach((text, index) => { s.prompts[index].text = text; });
    const p = buildDrRoofDemo(s);
    expect(p.prompts.slice(0, 5).map(prompt => prompt.stage)).toEqual(['understand', 'prefer', 'trust', 'convert', 'trust']);
    expect(p.prompts.slice(0, 5).map(prompt => prompt.text)).toEqual(questions);
    expect(buildDrRoofDemo(source(), '2026-08-31').demo?.startDate).toBe('2026-02-28');
    expect(() => buildDrRoofDemo(source(), '2026-02-30')).toThrow('valid --anchor');
  });

  it('enrolls three distinct official blogs per week with source dates preserved and deterministic scenario dates', () => {
    const p = project(), urls = p.demo!.trackedUrls!;
    expect(urls).toHaveLength(156);
    expect(new Set(urls.map(url => url.createdAt)).size).toBe(156);
    expect(urls.every(url => url.contentType === 'BLOG' && url.publishedAt === url.createdAt && url.sourcePublishedAt === '2026-01-12T00:00:00.000Z')).toBe(true);
    expect(urls.every(url => url.publishedAt >= `${p.demo!.startDate}T00:00:00.000Z` && url.publishedAt <= `${p.demo!.endDate}T23:59:59.999Z`)).toBe(true);
    expect(project().demo?.trackedUrls).toEqual(urls);
    for (const url of ['https://evil.example/blog/a', 'https://drroof.com.evil.example/blog/a', 'https://drroof.com/about/', 'http://drroof.com/blog/a', 'https://user:password@drroof.com/blog/a'])
      expect(() => buildDrRoofDemo({ ...source(), blogs: [{ ...source().blogs[0], url }] })).toThrow();
    expect(() => buildDrRoofDemo({ ...source(), blogs: Array.from({ length: 201 }, () => source().blogs[0]) })).toThrow();
  });

  it('shows the current weekly posts and citations in the default views while retaining future publications', async () => {
    const p = project(), now = () => new Date('2026-10-25T12:00:00.000Z'), repository = new MemoryRepository();
    await repository.saveProject(p, null);
    const runtime = withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, now);
    for (const [days, count] of [[7, 3], [30, 12]]) {
      const response = await monitoringRoute(runtime, p, 'tracked-urls', new Request(`https://citevia.test/v1/projects/${p.id}/tracked-urls?days=${days}`), now(), async () => { throw new Error('GET only'); });
      expect(response?.status).toBe(200);
      const data = await response!.json();
      expect(data.total).toBe(count);
      expect(data.items.every((item: { publishedAt: string }) => item.publishedAt <= now().toISOString())).toBe(true);
      expect(data.items.reduce((sum: number, item: { periodAppearances: number }) => sum + item.periodAppearances, 0)).toBeGreaterThan(0);
    }
    const dates = [...new Set(p.demo!.trackedUrls!.map(url => url.publishedAt))];
    expect(dates.filter(date => date >= '2026-10-19' && date < '2026-10-26')).toEqual([
      '2026-10-19T08:00:00.000Z', '2026-10-21T08:00:00.000Z', '2026-10-23T08:00:00.000Z',
    ]);
    expect(dates.some(date => date > now().toISOString())).toBe(true);
    const [urls, matches, history] = await Promise.all([
      runtime.repository.listTrackedUrls(p.id), runtime.repository.listTrackingMatches(p.id),
      runtime.repository.listPromptHistory(p.id, `${p.demo!.startDate}T00:00:00Z`, now().toISOString()),
    ]);
    const scans = [...new Set(history.runs.map(run => run.scheduledAt))].sort();
    for (const url of urls.filter(url => url.publishedAt <= now().toISOString())) {
      const firstScan = scans.find(at => at >= url.publishedAt);
      const received = matches.filter(match => match.trackedUrlId === url.id && match.capture.capturedAt <= now().toISOString());
      if (firstScan) {
        expect(received.some(match => match.capture.capturedAt.slice(0, 10) === firstScan.slice(0, 10)), `${url.publishedAt} receives a citation in its next scheduled scan`).toBe(true);
      } else expect(received).toEqual([]);
    }
    expect(await repository.listRuns(p.id)).toEqual([]);
  });

  it('uses an exact Monday/Wednesday/Friday cadence with seventy-eight past posts and no repeated URLs', () => {
    const p = project(), urls = p.demo!.trackedUrls!, weeks = new Map<string, number>();
    for (const url of urls) {
      const date = new Date(url.publishedAt);
      expect([1, 3, 5]).toContain(date.getUTCDay());
      expect(url.publishedAt.endsWith('T08:00:00.000Z')).toBe(true);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const week = date.toISOString().slice(0, 10); weeks.set(week, (weeks.get(week) || 0) + 1);
    }
    expect(weeks.size).toBe(52);
    expect([...weeks.values()].every(count => count === 3)).toBe(true);
    expect(urls.filter(url => url.publishedAt < '2026-10-26T00:00:00Z')).toHaveLength(78);
    expect(new Set(urls.map(url => url.url)).size).toBe(156);
    expect(() => buildDrRoofDemo({ ...source(), blogs: source().blogs.slice(0, 77) })).toThrow('at least 78 distinct official blogs');
    const currentOnly = buildDrRoofDemo({ ...source(), blogs: source().blogs.slice(0, 78) });
    expect(currentOnly.demo?.trackedUrls).toHaveLength(78);
    const originals = source().blogs.slice(0, 78);
    const repeated = buildDrRoofDemo({ ...source(), blogs: [...originals,
      { ...originals[0], url: `${originals[0].url}?utm_source=chatgpt#section` }] });
    expect(repeated.demo?.trackedUrls).toHaveLength(78);
  });

  it('previews without mutation, creates only compact configuration and is idempotent', async () => {
    const repository = new MemoryRepository(), p = project(), save = vi.spyOn(repository, 'saveProject');
    expect(await createDrRoofDemo(repository, p)).toMatchObject({ status: 'preview', prompts: 50, competitors: 5, trackedUrls: 156,
      persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(await repository.getProject(p.id)).toBeNull();
    expect((await createDrRoofDemo(repository, p, true)).status).toBe('created');
    expect((await createDrRoofDemo(repository, p, true)).status).toBe('exists');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await repository.listRuns(p.id)).toEqual([]);
    expect(await repository.listPromptHistory(p.id, '2026-01-01', '2027-12-31')).toEqual({ runs: [], results: [] });
  });

  it('refuses to replace a real account or another scenario and stops on concurrent creation', async () => {
    const repository = new MemoryRepository(), p = project();
    await repository.saveProject({ ...p, demo: undefined }, null);
    await expect(createDrRoofDemo(repository, p, true)).rejects.toThrow('existing real account');
    const another = new MemoryRepository();
    await another.saveProject({ ...p, demo: { ...p.demo!, source: 'igeo-nayax' } }, null);
    await expect(createDrRoofDemo(another, p, true)).rejects.toThrow('existing real account');
    await expect(createDrRoofDemo({ getProject: async () => null, saveProject: async () => false }, p, true)).rejects.toThrow('concurrently');
    await expect(createDrRoofDemo(new MemoryRepository(), { ...p, id: 'real-account' }, true)).rejects.toThrow('demo identity');
  });
});
