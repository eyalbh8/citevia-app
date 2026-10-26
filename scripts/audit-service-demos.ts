import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type CapturedAnswer, type Project, type TrafficFilters } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, PostgresRepository, withDemoRuntime } from '@citevia/storage';
import { buildServiceDemo } from './create-service-demo.js';
import { openConfigurationDatabase } from './configure-analysis.js';

const { values } = parseArgs({ options: {
  source: { type: 'string', multiple: true }, mode: { type: 'string' }, output: { type: 'string' },
} });
assert(values.source?.length, 'Supply at least one --source JSON file.');
assert(!values.mode || ['local', 'aws'].includes(values.mode), 'Choose --mode local|aws, or omit for an in-memory audit.');
const inputs = (await Promise.all(values.source.map(async path => {
  const value = JSON.parse(await readFile(resolve(path), 'utf8'));
  return Array.isArray(value) ? value : value.accounts || [value];
}))).flat();
const desired = inputs.map(value => buildServiceDemo(value));
assert.equal(new Set(desired.map(project => project.id)).size, desired.length, 'Duplicate account identity.');
const db = values.mode ? await openConfigurationDatabase(values.mode as 'local' | 'aws', resolve(process.env.LOCAL_DATA_DIR || '.local-data/real')) : null;
const base = db ? new PostgresRepository(db) : new MemoryRepository();
const artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
const runtime = withDemoRuntime({ repository: base, artifacts, queue });

const month = (year: number, index: number): TrafficFilters => ({
  period: { start: new Date(Date.UTC(year, index, 1)).toISOString(), end: new Date(Date.UTC(year, index + 1, 1) - 1).toISOString(), granularity: 'daily', timezone: 'UTC' },
  previous: { start: new Date(Date.UTC(year, index - 1, 1)).toISOString(), end: new Date(Date.UTC(year, index, 1) - 1).toISOString(), granularity: 'daily', timezone: 'UTC' },
  providers: [], countries: [],
});

try {
  const accounts = [];
  for (const planned of desired) {
    if (!db) await base.saveProject(planned, null);
    const project = (await base.getProject(planned.id))!;
    assert(project, `Missing saved account: ${planned.name}`);
    assert.equal(project.demo?.source, 'website-demo');
    assert.equal(project.brand.domains[0], planned.brand.domains[0]);
    assert.equal(project.enabled, false);
    assert.deepEqual(project.demo?.profile, planned.demo?.profile);
    assert.deepEqual(project.demo?.trackedUrls, planned.demo?.trackedUrls);
    assert.deepEqual(project.prompts.map(item => item.text), planned.prompts.map(item => item.text));
    assert.equal(project.prompts.length, 50);
    assert.equal(project.language, 'en');
    assert.equal(new Set(project.prompts.map(item => item.text.toLowerCase())).size, 50);
    assert(project.prompts.every(item => item.active));
    assert.equal(project.competitors.length, 5);
    assert.equal(await base.listRuns(project.id).then(items => items.length), 0, 'Demo measurements should be derived.');
    const config = project.demo!;
    const history = await runtime.repository.listPromptHistory(project.id, `${config.startDate}T00:00:00.000Z`, `${config.endDate}T23:59:59.999Z`);
    assert(history.runs.length >= 300 && history.results.length === history.runs.length * 50);
    assert(history.results.every(item => item.citationCount > 0), 'Every demo answer needs citations.');
    assert(history.results.every(item => item.brands?.some(brand => brand.mentioned)), 'Every prompt should surface a tracked company.');
    const runs = new Map(history.runs.map(run => [run.id, run]));
    const captureKeys = history.results.map(result => `${runs.get(result.runId)!.snapshot.provider}:${result.captureKey}`);
    const citations = await runtime.repository.listNativeCitations(project.id, captureKeys);
    const firstCited = new Map<string, string>();
    for (const item of citations) {
      const runId = item.captureKey.split('/').at(-3)!;
      const at = runs.get(runId)?.scheduledAt;
      assert(at, `Missing citation run ${runId}`);
      for (const citation of item.citations) {
        if (!firstCited.has(citation.url) || firstCited.get(citation.url)! > at) firstCited.set(citation.url, at);
      }
    }
    const publications = config.trackedUrls!;
    const scans = [...new Set(history.runs.map(run => run.scheduledAt))].sort();
    for (const article of publications) {
      const first = firstCited.get(article.url);
      assert(first && first >= article.publishedAt, `Uncited or prematurely cited article: ${article.url}`);
      assert.equal(first, scans.find(at => at >= article.publishedAt), 'Article should be cited in its first subsequent scan.');
    }
    const share = (start: string, end: string) => {
      const results = history.results.filter(item => item.capturedAt! >= start && item.capturedAt! <= end);
      assert(results.length > 0);
      return Number((100 * results.filter(item => item.target?.mentioned).length / results.length).toFixed(2));
    };
    const start = new Date(`${config.anchorDate}T00:00:00Z`);
    const anchorMonth = start.getUTCMonth(), year = start.getUTCFullYear();
    const visibility = [-5, 0, 5].map(offset => {
      const range = month(year, anchorMonth + offset);
      return share(range.period.start, range.period.end);
    });
    assert(visibility[0] < visibility[1] && visibility[1] < visibility[2], 'Visibility must increase.');
    const monthlyTraffic = [];
    for (let offset = -5; offset <= 5; offset++) {
      const range = month(year, anchorMonth + offset);
      const traffic = await runtime.repository.aggregateTraffic(project.id, range);
      assert.equal(traffic.current, traffic.providers.reduce((sum, item) => sum + item.visits, 0));
      assert.equal(traffic.current, traffic.series.reduce((sum, item) => sum + Object.values(item.values).reduce((total, count) => total + count, 0), 0));
      if (monthlyTraffic.length) assert(traffic.current > monthlyTraffic.at(-1)!.visits, 'Monthly AI referrals should grow.');
      monthlyTraffic.push({ month: range.period.start.slice(0, 7), visits: traffic.current });
    }
    for (const result of [history.results[0], history.results.at(-1)!]) {
      const answer = await runtime.artifacts.get<CapturedAnswer>(result.captureKey!);
      assert(answer?.text && answer.citations.length > 0);
      assert(project.competitors.some(brand => answer.text.includes(brand.name)) || answer.text.includes(project.name));
    }
    if (db) {
      const mirrors = await db.query<{ prompts: number; competitors: number }>(
        `SELECT (SELECT count(*)::int FROM prompts WHERE account_id=p.account_id AND is_active) AS prompts,
          (SELECT count(*)::int FROM competitors WHERE account_id=p.account_id AND status='ACTIVE') AS competitors
         FROM citevia_projects p WHERE p.id=$1`, [project.id]);
      assert.deepEqual(mirrors.rows[0], { prompts: 50, competitors: 5 });
    }
    accounts.push({ id: project.id, name: project.name, country: project.country, prompts: 50, competitors: 5,
      startDate: config.startDate, anchorDate: config.anchorDate, endDate: config.endDate,
      providerScans: history.runs.length, answers: history.results.length, everyAnswerHasCitationsAndCompanies: true,
      publications: publications.length, allPublicationsCited: true,
      officialArticles: publications.filter(item => !item.demoPost).length,
      demoArticles: publications.filter(item => item.demoPost).length,
      visibility: { firstFullMonth: visibility[0], anchorMonth: visibility[1], lastFullMonth: visibility[2] },
      aiTraffic: monthlyTraffic, profile: config.profile, configurationBytes: Buffer.byteLength(JSON.stringify(project)) });
    console.error(`Verified ${project.name}: 50 prompts, ${history.results.length} answers, ${publications.length} cited publications.`);
  }
  assert.equal(new Set(accounts.map(item => item.visibility.anchorMonth)).size, accounts.length, 'Each account should have a different anchor visibility percentage.');
  assert.equal(new Set(accounts.map(item => item.profile!.monthlyGrowth)).size, accounts.length, 'Each account should have a different traffic growth percentage.');
  const report = { checkedAt: new Date().toISOString(), backend: values.mode || 'memory', accounts,
    totals: { accounts: accounts.length, prompts: accounts.length * 50, answers: accounts.reduce((sum, item) => sum + item.answers, 0),
      publications: accounts.reduce((sum, item) => sum + item.publications, 0), paidProviderCalls: 0 } };
  if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { if (db) await db.close(); }
