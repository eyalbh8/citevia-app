import { describe, expect, it, vi } from 'vitest';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, withDemoRuntime } from '@citevia/storage';
import type { CapturedAnswer, RunSummary } from '@citevia/core';
import {
  buildServiceDemo, createServiceDemo, SERVICE_DEMO_CONTENT_ORIGIN, SERVICE_DEMO_DATES, serviceDemoDates, serviceDemoProfile,
} from '../scripts/create-service-demo.js';

const copiedAt = '2026-10-25T12:00:00.000Z';
const source = () => ({
  id: 'account_gutter_services_demo_v1', name: 'Fixture Gutter Services', website: 'https://www.fixture-gutters.com/',
  country: 'US', industry: 'Gutter services', serviceArea: 'Central Ohio', audience: ['Homeowners'],
  services: ['Gutter installation', 'Gutter guards', 'Gutter cleaning', 'Gutter repairs', 'Downspout services'],
  description: 'Fixture Gutter Services lists gutter installation and maintenance services for homeowners in Central Ohio.',
  criteria: ['Service scope', 'Materials', 'Installation and follow-up'],
  competitors: Array.from({ length: 5 }, (_, index) => ({ name: `Fixture competitor ${index + 1}`, website: `https://fixture-competitor-${index + 1}.com/` })),
  sources: [
    { url: 'https://www.fixture-gutters.com/services/', title: 'Services', kind: 'official', claims: ['Gutter installation is a listed service.'] },
    { url: 'https://www.thisoldhouse.com/gutters', title: 'Independent gutter guide', kind: 'independent' },
    { url: 'https://www.fixture-gutters.com/about/', title: 'About', kind: 'official', quote: 'We install gutter systems.', field: 'about' },
  ],
  blogs: Array.from({ length: 44 }, (_, index) => ({ url: `https://www.fixture-gutters.com/blog/gutter-care-${index + 1}/`,
    title: `Verified fixture article ${index + 1}`, sourcePublishedAt: '2025-01-01' })),
  brandbook: { toneOfVoice: ['Clear', 'Helpful'], values: ['Reliability'], personality: ['Practical'], sitemapUrl: 'https://www.fixture-gutters.com/sitemap.xml' },
  traffic: { pages: ['/', '/services/', '/contact/'], countries: ['US', 'CA'], devices: ['mobile', 'desktop'], browsers: ['Chrome', 'Safari'] },
});

describe('compact public website service demos', () => {
  it('names and cites a researched company while keeping a separate, steadily growing target plan', async () => {
    const legacy = buildServiceDemo(source(), copiedAt);
    const discovery = buildServiceDemo({ ...source(), companyDiscovery: true }, copiedAt);
    const setup = async (project: typeof legacy) => {
      const repository = new MemoryRepository();
      await repository.saveProject(project, null);
      return withDemoRuntime({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() });
    };
    const before = await setup(legacy), after = await setup(discovery);
    const range = ['2026-04-25T00:00:00.000Z', '2027-04-25T23:59:59.999Z'] as const;
    const original = await before.repository.listPromptHistory(legacy.id, ...range);
    const current = await after.repository.listPromptHistory(discovery.id, ...range);
    expect(original.results.some(result => !result.brands?.some(brand => brand.mentioned))).toBe(true);
    expect(current.results.every(result => result.brands?.some(brand => brand.mentioned))).toBe(true);
    for (const provider of ['openai', 'perplexity', 'gemini']) {
      const runs = current.runs.filter(run => run.snapshot.provider === provider).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      let previous = 0;
      for (const run of runs) {
        const mentions = current.results.filter(result => result.runId === run.id && result.target?.mentioned).length;
        expect(mentions).toBeGreaterThanOrEqual(previous);
        previous = mentions;
      }
    }
    const empty = original.results.find(result => !result.brands?.some(brand => brand.mentioned) &&
      current.results.some(item => item.runId === result.runId && item.promptId === result.promptId && !item.target?.mentioned))!;
    const filled = current.results.find(result => result.runId === empty.runId && result.promptId === empty.promptId)!;
    const brand = discovery.competitors.find(brand => filled.brands?.some(measured => measured.brandId === brand.id && measured.mentioned))!;
    const answer = (await after.artifacts.get<CapturedAnswer>(filled.captureKey!))!;
    expect(answer.text).toContain(brand.name);
    expect(answer.citations.some(citation => new URL(citation.url).hostname === brand.domains[0])).toBe(true);
    expect(filled.target?.mentioned).toBe(false);
  });

  it('anchors new accounts to six calendar months each way while retaining legacy scenario dates', async () => {
    const project = buildServiceDemo({ ...source(), anchorDate: '2026-10-26' }, copiedAt);
    expect(project.demo).toMatchObject({ anchorDate: '2026-10-26', startDate: '2026-04-26', endDate: '2027-04-26' });
    expect(project.createdAt).toBe('2026-04-26T00:00:00.000Z');
    expect(project.demo!.trackedUrls).toHaveLength(44);
    expect(project.demo!.trackedUrls!.at(-1)!.publishedAt).toBe('2027-04-19T08:00:00.000Z');
    expect(await createServiceDemo(new MemoryRepository(), project)).toMatchObject({
      status: 'preview', startDate: '2026-04-26', endDate: '2027-04-26', trackedUrls: 44,
    });
    expect(serviceDemoDates()).toEqual(SERVICE_DEMO_DATES);
    expect(serviceDemoDates('2026-08-31')).toEqual({ anchorDate: '2026-08-31', startDate: '2026-02-28', endDate: '2027-02-28' });
    expect(() => serviceDemoDates('2026-02-30')).toThrow('valid scenario anchor');
    expect(() => serviceDemoDates('not-a-date')).toThrow('valid scenario anchor');
  });

  it('builds fifty industry/region questions and a complete researched brandbook without customer data', () => {
    const original = source(), before = structuredClone(original), project = buildServiceDemo(original, copiedAt);
    expect(original).toEqual(before);
    expect(project.prompts).toHaveLength(50);
    expect(new Set(project.prompts.map(prompt => prompt.text)).size).toBe(50);
    expect(project.prompts.every(prompt => original.services.some(service => prompt.text.includes(service.toLowerCase())))).toBe(true);
    expect(project.prompts.filter(prompt => prompt.branded)).toHaveLength(10);
    expect(new Set(project.prompts.map(prompt => prompt.stage))).toEqual(new Set(['understand', 'prefer', 'trust', 'convert']));
    expect(project.competitors.map(competitor => competitor.name)).toEqual(original.competitors.map(competitor => competitor.name));
    expect(project.brandbook).toMatchObject({ about: original.description, industryCategory: original.industry,
      keyFeatures: original.services, toneOfVoice: original.brandbook.toneOfVoice, values: original.brandbook.values,
      personality: original.brandbook.personality, targetAudience: original.audience, model: 'public-website-demo' });
    expect(project.brandbook?.evidence).toEqual([{ field: 'about', quote: original.sources[2].quote, url: original.sources[2].url }]);
    expect(project.brandbook?.knowledgeSources).toEqual(expect.arrayContaining(original.sources.map(item => item.url)));
    expect(project.brandbook?.evidence.some(evidence => evidence.quote === original.sources[0].claims?.[0])).toBe(false);
    expect(project.demo).toMatchObject({ source: 'website-demo', sourceAccountId: 'website:fixture-gutters.com', ...SERVICE_DEMO_DATES,
      industry: { label: original.industry, audience: 'Homeowners', services: original.services, criteria: original.criteria }, traffic: original.traffic });
    expect(project.demo?.samples?.[0].citations?.slice(0, 3).map(citation => citation.url))
      .toEqual([original.blogs[0].url, original.competitors[0].website, original.sources[1].url]);
    expect(project.enabled).toBe(false);
    expect(project.scanSchedule?.slotsUtcMinutes).toEqual([600, 5640]);
    expect(project.scanProviders?.map(provider => provider.provider)).toEqual(['openai', 'perplexity', 'gemini']);
    expect(Buffer.byteLength(JSON.stringify(project))).toBeLessThan(250000);
  });

  it('tracks only distinct official articles across past and future scenario enrollment dates', () => {
    const project = buildServiceDemo(source(), copiedAt), articles = project.demo!.trackedUrls!;
    expect(articles).toHaveLength(44);
    expect(new Set(articles.map(article => article.url)).size).toBe(44);
    expect(articles.filter(article => article.publishedAt <= copiedAt)).toHaveLength(22);
    expect(articles.some(article => article.publishedAt > copiedAt)).toBe(true);
    for (const article of articles) {
      expect(source().blogs.map(blog => blog.url)).toContain(article.url);
      expect(article.demoPost).toBeUndefined();
      expect(article.body).toBeUndefined();
      expect(article.sourcePublishedAt).toBe('2025-01-01T00:00:00.000Z');
    }
    expect(buildServiceDemo(source(), copiedAt)).toEqual(project);
  });

  it('deduplicates actual article URLs without dummy parameters or repeat enrollment', () => {
    const value = source();
    value.blogs.push({ ...value.blogs[0], url: `${value.blogs[0].url}?utm_source=chatgpt#section` });
    const project = buildServiceDemo(value, copiedAt);
    expect(project.demo?.trackedUrls?.filter(article => !article.demoPost)).toHaveLength(44);
    expect(project.demo?.trackedUrls?.filter(article => article.demoPost)).toHaveLength(0);
    const allReal = source();
    allReal.blogs = Array.from({ length: 156 }, (_, index) => ({ ...allReal.blogs[0], url: `https://www.fixture-gutters.com/blog/article-${index}/` }));
    expect(buildServiceDemo(allReal, copiedAt).demo?.trackedUrls?.some(article => article.demoPost)).toBe(false);
  });

  it('enrolls distinct YouTube videos and Reddit threads independently across the year', async () => {
    const socialLinks = [
      { url: 'https://www.youtube.com/watch?v=cAr3-OCCwLo', title: 'Investing journey' },
      { url: 'https://www.youtube.com/watch?v=0HZImOYM-Ns', title: 'Building a portfolio' },
      { url: 'https://www.reddit.com/r/Etoro/comments/1gkeyug/', title: 'Copy trading' },
      { url: 'https://www.reddit.com/r/Etoro/comments/1mgvwsk/', title: 'Copy trader' },
    ];
    const project = buildServiceDemo({ ...source(), socialLinks: [...socialLinks, socialLinks[0]] }, copiedAt);
    const social = project.demo!.trackedUrls!.filter(item => item.contentType === 'SOCIAL');
    expect(social.map(item => item.url)).toEqual(socialLinks.map(item => item.url));
    expect(social[0].publishedAt).toBe(social[2].publishedAt);
    expect(social[1].publishedAt).toBe(social[3].publishedAt);
    expect(Date.parse(social[0].publishedAt)).toBeLessThan(Date.parse(copiedAt));
    expect(Date.parse(social[1].publishedAt)).toBeGreaterThan(Date.parse(copiedAt));
    expect(await createServiceDemo(new MemoryRepository(), project)).toMatchObject({
      status: 'preview', officialArticles: 44, socialLinks: 4, trackedUrls: 48,
    });
  });

  it('rejects social homepages, unrelated hosts and URLs mislabeled to bypass company ownership', async () => {
    for (const url of ['https://www.youtube.com/', 'https://www.reddit.com/r/Etoro/',
      'https://www.youtube.com/watch?v=invalid', 'https://www.youtube.com.evil.com/watch?v=cAr3-OCCwLo',
      'https://unrelated.com/article', 'http://www.reddit.com/r/Etoro/comments/1gkeyug/'])
      expect(() => buildServiceDemo({ ...source(), socialLinks: [{ url, title: 'Invalid social link' }] })).toThrow();
    const project = buildServiceDemo(source(), copiedAt);
    project.demo!.trackedUrls!.push({ url: 'https://unrelated.com/article', title: 'Forged social link',
      contentType: 'SOCIAL', publishedAt: copiedAt });
    await expect(createServiceDemo(new MemoryRepository(), project, true)).rejects.toThrow('YouTube video or Reddit discussion');
  });

  it('accepts explicitly researched prompts, industry copy and modest deterministic numeric variations', () => {
    const value = source();
    const prompts = Array.from({ length: 50 }, (_, index) => ({ text: `What should a homeowner ask about gutter option ${index + 1}?`,
      stage: 'trust', topic: 'Published gutter options', tags: ['research'], seoKeyword: `gutter option ${index + 1}` }));
    const copy = { introduction: 'Review the service scope and materials before deciding.', positiveCompany: ' offers the listed gutter services.',
      neutralCompany: ' is another provider to compare.', fallback: 'Compare service proposals before selecting a contractor.' };
    const project = buildServiceDemo({ ...value, prompts, copy, profile: { trafficScale: 1.05 } }, copiedAt);
    expect(project.prompts.map(prompt => prompt.text)).toEqual(prompts.map(prompt => prompt.text));
    expect(project.prompts.every(prompt => prompt.stage === 'trust' && prompt.topic === 'Published gutter options' && prompt.tags?.[0] === 'research')).toBe(true);
    expect(project.demo?.copy).toEqual(copy);
    expect(project.demo?.profile).toEqual({ ...serviceDemoProfile(value.id), trafficScale: 1.05 });
    expect(serviceDemoProfile(value.id)).toEqual(serviceDemoProfile(value.id));
    expect(serviceDemoProfile(value.id)).not.toEqual(serviceDemoProfile('account_another_company_demo_v1'));
  });

  it('uses provided automotive and commercial audiences for their corresponding services', () => {
    const value = source();
    const project = buildServiceDemo({ ...value, audience: ['Homeowners', 'Vehicle owners', 'Business owners'],
      services: ['Residential lock rekeying', 'Car key and fob replacement', 'Commercial access control', 'Smart lock installation', 'Safe opening and repair'] }, copiedAt);
    expect(project.prompts[0].text).toContain('homeowners');
    expect(project.prompts[10].text).toContain('vehicle owners');
    expect(project.prompts[20].text).toContain('business owners');
    expect(project.demo?.trackedUrls?.every(article => !article.demoPost && article.url.startsWith(value.website))).toBe(true);
  });

  it('rejects duplicate questions/services/competitors and unverified company URLs', () => {
    const value = source();
    expect(() => buildServiceDemo({ ...value, services: Array(5).fill(value.services[0]) })).toThrow('five distinct');
    expect(() => buildServiceDemo({ ...value, competitors: Array(5).fill(value.competitors[0]) })).toThrow('five distinct');
    expect(() => buildServiceDemo({ ...value, competitors: [value.competitors[0], value.competitors[1], value.competitors[2], value.competitors[3],
      { name: value.name, website: value.website }] })).toThrow('excluding the selected company');
    expect(() => buildServiceDemo({ ...value, prompts: Array(50).fill({ text: 'Which gutter provider should I use?' }) })).toThrow('fifty distinct');
    expect(() => buildServiceDemo({ ...value, sources: [value.sources[0]] })).toThrow('independent public reference');
    for (const url of ['https://fixture-gutters.com.evil.com/article', 'https://app.citevia.io/demo-content/fake/article'])
      expect(() => buildServiceDemo({ ...value, blogs: [{ url, title: 'Unverified article' }] })).toThrow('official company website');
    expect(() => buildServiceDemo({ ...value, website: 'https://user:password@fixture-gutters.com/' })).toThrow();
    expect(() => buildServiceDemo({ ...value, profile: { trafficScale: 100 } })).toThrow();
  });

  it('previews, creates only compact configuration, stays idempotent and protects existing identities', async () => {
    const repository = new MemoryRepository(), project = buildServiceDemo(source(), copiedAt), save = vi.spyOn(repository, 'saveProject');
    expect(await createServiceDemo(repository, project)).toMatchObject({ status: 'preview', prompts: 50, competitors: 5,
      trackedUrls: 44, officialArticles: 44, demoArticles: 0, persistedSyntheticAnswers: 0, persistedSyntheticTrafficEvents: 0, paidCalls: 0 });
    expect(save).not.toHaveBeenCalled();
    expect((await createServiceDemo(repository, project, true)).status).toBe('created');
    expect((await createServiceDemo(repository, project, true)).status).toBe('exists');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await repository.listRuns(project.id)).toEqual([]);
    expect(await repository.listPromptHistory(project.id, '2020-01-01', '2030-01-01')).toEqual({ runs: [], results: [] });
    const real = new MemoryRepository();
    await real.saveProject({ ...project, demo: undefined }, null);
    await expect(createServiceDemo(real, project, true)).rejects.toThrow('existing real account');
    const other = new MemoryRepository();
    await other.saveProject({ ...project, demo: { ...project.demo!, sourceAccountId: 'website:another-company.com' } }, null);
    await expect(createServiceDemo(other, project, true)).rejects.toThrow('another website demo');
    await expect(createServiceDemo({ getProject: async () => null, saveProject: async () => false }, project, true)).rejects.toThrow('concurrently');
    await expect(createServiceDemo(repository, { ...project, enabled: true }, true)).rejects.toThrow('demo identity');
    const forged = structuredClone(project);
    forged.demo!.trackedUrls![0].url = 'https://app.citevia.io/demo-content/another-account/article';
    await expect(createServiceDemo(new MemoryRepository(), forged, true)).rejects.toThrow('selected company website');
    const traversal = structuredClone(project);
    traversal.demo!.trackedUrls![0].url = `${SERVICE_DEMO_CONTENT_ORIGIN}/demo-content/${project.id}/../another-account/article`;
    await expect(createServiceDemo(new MemoryRepository(), traversal, true)).rejects.toThrow('selected company website');
  });

  it('derives current history and website-specific answers while leaving underlying measurements empty', async () => {
    const project = buildServiceDemo(source(), copiedAt), base = new MemoryRepository();
    await createServiceDemo(base, project, true);
    const runtime = withDemoRuntime({ repository: base, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, () => new Date(copiedAt));
    const history = await runtime.repository.listPromptHistory(project.id, '2026-10-19T00:00:00Z', copiedAt);
    expect(history.runs).toHaveLength(6);
    expect(history.results).toHaveLength(300);
    const result = history.results.find(result => result.target?.mentioned)!;
    const answer = await runtime.artifacts.get<{ text: string }>(result.captureKey!);
    expect(answer?.text).toMatch(/gutter|service scope|materials/i);
    expect(answer?.text).not.toMatch(/analytics|attribution|cashless/i);
    const urls = await runtime.repository.listTrackedUrls(project.id);
    expect(urls.some(url => url.publishedAt > copiedAt)).toBe(true);
    const current = urls.filter(url => url.publishedAt <= copiedAt);
    expect(current).toHaveLength(22);
    expect(current.every(url => source().blogs.some(blog => blog.url === url.url))).toBe(true);
    expect(await base.listRuns(project.id)).toEqual([]);
  });

  it('fills latest-scan Sources from varied real competitor references and the same saved native citations', async () => {
    const value = source(), project = buildServiceDemo(value, copiedAt), base = new MemoryRepository();
    await createServiceDemo(base, project, true);
    const runtime = withDemoRuntime({ repository: base, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, () => new Date(copiedAt));
    const run = (await runtime.repository.listRuns(project.id, 1))[0];
    const summary = await runtime.artifacts.get<RunSummary>(run.summaryKey!);
    const domains = new Set(summary!.domains.map(row => row.domain));
    for (const competitor of value.competitors) expect(domains.has(new URL(competitor.website).hostname)).toBe(true);
    expect(domains.has('fixture-gutters.com')).toBe(true);
    expect(domains.has('thisoldhouse.com')).toBe(true);
    expect(domains.has('reddit.com')).toBe(true);
    expect(domains.has('citevia.io')).toBe(false);
    expect(domains.size).toBe(8);
    const redditPosition = summary!.domains.findIndex(row => row.domain === 'reddit.com') + 1;
    expect(redditPosition).toBeGreaterThanOrEqual(2);
    expect(redditPosition).toBeLessThanOrEqual(5);
    const allowedUrls = new Set([value.website, `https://${project.brand.domains[0]}/`, 'https://www.reddit.com/', ...value.blogs.map(blog => blog.url), ...value.sources.map(reference => reference.url),
      ...value.competitors.map(competitor => competitor.website), ...project.demo!.trackedUrls!.map(article => article.url)]);
    expect(summary!.urls.filter(row => !allowedUrls.has(row.url!)).map(row => row.url)).toEqual([]);
    const results = await runtime.repository.listResults(project.id, run.id);
    const answers = await Promise.all(results.map(result => runtime.artifacts.get<CapturedAnswer>(result.captureKey!)));
    const nativeCitations = answers.reduce((sum, answer) => sum + answer!.citations.length, 0);
    expect(summary!.metrics.citations).toBe(nativeCitations);
    expect(summary!.urls.reduce((sum, row) => sum + row.citationCount, 0)).toBe(nativeCitations);
    expect(await base.listRuns(project.id)).toEqual([]);
  });
});
