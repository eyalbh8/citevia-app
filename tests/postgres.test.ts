import { testIdentity } from './fixtures/users.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import {
  PostgresRepository,
  MemoryArtifacts,
  MemoryQueue,
  migrateDatabase,
  uuidFor,
  type SqlDatabase,
} from '@citevia/storage';
import { createAccounts } from '../apps/api/src/onboarding.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import { FixtureProvider, newProject } from './fixtures/scanner.js';
import { FixtureOnboardingProvider } from './fixtures/onboarding.js';
import { ProviderError } from '../apps/scanner/src/provider.js';
let db: SqlDatabase, repository: PostgresRepository;
beforeAll(async () => {
  db = await localPostgres();
  repository = new PostgresRepository(db);
  await repository.syncUser(testIdentity('paging-owner'));
  await repository.syncUser(testIdentity('postgres-owner'));
}, 30000);
afterAll(async () => {
  await db?.close();
});
describe('iGEO-compatible PostgreSQL persistence', () => {
  it('searches and pages lightweight summaries within the authenticated membership', async () => {
    for (const name of ['Paging Alpha', 'Paging Beta', 'Paging Gamma']) {
      const project = newProject({
        id: name.replaceAll(' ', '-'),
        name,
        prompts: ['Which tool is useful?'],
      });
      await repository.saveProject(project, null);
      await repository.putMembership({
        projectId: project.id,
        userId: 'paging-owner',
        role: 'owner',
      });
    }
    const first = await repository.listProjectSummaries('paging-owner', {
      offset: 0,
      limit: 1,
    });
    const second = await repository.listProjectSummaries('paging-owner', {
      offset: 1,
      limit: 1,
    });
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe('MQ');
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(first.items[0].prompts).toEqual([]);
    expect(first.items[0].brandbook).toBeUndefined();
    expect(first.items[0].activePromptCount).toBe(1);
    expect(
      (
        await repository.listProjectSummaries('paging-owner', {
          offset: 0,
          limit: 25,
          query: 'Beta',
        })
      ).items.map((item) => item.name),
    ).toEqual(['Paging Beta']);
    expect(
      (
        await repository.listProjectSummaries('not-a-member', {
          offset: 0,
          limit: 25,
        })
      ).total,
    ).toBe(0);
  });
  it('applies the complete baseline and idempotent migration ledger', async () => {
    await migrateDatabase(db);
    const migrations = (await db.query('SELECT name FROM citevia_migrations')).rows;
    expect(migrations).toEqual(expect.arrayContaining([{ name: '009_agent_posts.sql' }]));
    expect(migrations).toHaveLength(10);
    const fields = (
      await db.query(
        `SELECT column_name,data_type FROM information_schema.columns WHERE table_name='prompt_responses'`,
      )
    ).rows;
    expect(fields).toEqual(
      expect.arrayContaining([
        { column_name: 'account_id', data_type: 'uuid' },
        { column_name: 'json_response', data_type: 'jsonb' },
        { column_name: 'sources', data_type: 'ARRAY' },
        { column_name: 'response_rank', data_type: 'double precision' },
      ]),
    );
    expect(
      (
        await db.query(
          `SELECT table_name FROM information_schema.tables WHERE table_name IN ('accounts','users','user_accounts','prompts','topics','scans','results','account_settings')`,
        )
      ).rows,
    ).toHaveLength(8);
  });
  it('onboards, schedules and saves fifty original responses and extracted entities in iGEO tables', async () => {
    const queue = new MemoryQueue(),
      artifacts = new MemoryArtifacts(),
      runtime = { repository, queue, artifacts };
    const input = {
      name: 'Postgres Acme',
      website: 'https://acme.com',
      region: 'US',
      language: 'en',
    };
    const { items } = await createAccounts(
      runtime,
      'postgres-owner',
      'postgres-onboard-123',
      { accounts: [input] },
      new Date(),
      100,
    );
    const scanner = new Scanner({
      ...runtime,
      provider: new FixtureProvider(),
      onboarding: new OnboardingEngine(
        runtime,
        new FixtureOnboardingProvider(),
        async () => {},
      ),
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const project = (await repository.getProject(items[0].project.id))!,
      job = (await repository.getOnboarding(
        project.id,
        project.onboardingJobId!,
      ))!;
    expect(job.status).toBe('completed');
    expect(await repository.getRun(project.id, job.firstRunId!)).toMatchObject({
      status: 'completed',
      succeededCount: 50,
    });
    const accountId = uuidFor(project.id);
    expect(
      (
        await db.query('SELECT about,key_features FROM accounts WHERE id=$1', [
          accountId,
        ])
      ).rows[0],
    ).toMatchObject({
      about: expect.stringContaining(input.name),
      key_features: ['Sample offering'],
    });
    expect(
      (
        await db.query(
          'SELECT id FROM prompts WHERE account_id=$1 AND is_active=true',
          [accountId],
        )
      ).rows,
    ).toHaveLength(50);
    const rows = (
      await db.query(
        'SELECT response,sources,json_response,status,provider FROM prompt_responses WHERE account_id=$1',
        [accountId],
      )
    ).rows;
    expect(rows).toHaveLength(150);
    for (const provider of ['openai', 'perplexity', 'gemini'])
      expect(rows.filter((row) => row.provider === provider)).toHaveLength(50);
    expect(
      (
        await db.query(
          'SELECT DISTINCT provider FROM results WHERE account_id=$1',
          [accountId],
        )
      ).rows
        .map((row) => row.provider)
        .sort(),
    ).toEqual(['gemini', 'openai', 'perplexity']);
    const settings = (
      await db.query(
        'SELECT ai_engines FROM account_settings WHERE account_id=$1',
        [accountId],
      )
    ).rows[0];
    expect(
      (settings.ai_engines as { provider: string }[]).map(
        (config) => config.provider,
      ),
    ).toEqual(['openai', 'perplexity', 'gemini']);
    expect(
      rows.every(
        (row) =>
          row.status === 'COMPLETED' &&
          typeof row.response === 'string' &&
          Array.isArray(row.sources),
      ),
    ).toBe(true);
    expect(
      (
        await db.query('SELECT id FROM results WHERE account_id=$1', [
          accountId,
        ])
      ).rows.length,
    ).toBeGreaterThan(0);
    await scanner.finalize(project.id, job.firstRunId!);
    expect(
      (
        await db.query('SELECT id FROM prompt_responses WHERE account_id=$1', [
          accountId,
        ])
      ).rows,
    ).toHaveLength(150);
    expect(await repository.getMembership(project.id, 'other-user')).toBeNull();
    expect(await repository.listProjects('other-user')).toHaveLength(0);
  }, 30000);
  it('persists failed measurements as gaps and keeps transactional counters correct under duplicate delivery', async () => {
    const p = newProject({
      id: 'postgres-failure',
      prompts: ['A real question?'],
    });
    await repository.saveProject(p, null);
    const queue = new MemoryQueue(),
      scanner = new Scanner({
        repository,
        queue,
        artifacts: new MemoryArtifacts(),
        provider: {
          collect: async () => {
            throw new ProviderError('rejected', 'Failed collection', false);
          },
          extract: async () => {
            throw new Error('Must not extract');
          },
        },
      });
    await scanner.handle({
      kind: 'kickoff',
      projectId: p.id,
      scheduledAt: new Date().toISOString(),
      trigger: 'manual',
    });
    const message = queue.messages.shift()!;
    await Promise.all([scanner.handle(message), scanner.handle(message)]);
    const run = (await repository.listRuns(p.id))[0];
    expect(run).toMatchObject({
      terminalCount: 1,
      succeededCount: 0,
      status: 'failed',
    });
    expect(
      (
        await db.query(
          'SELECT response,status,visibility,response_rank FROM prompt_responses WHERE account_id=$1',
          [uuidFor(p.id)],
        )
      ).rows,
    ).toEqual([
      {
        response: null,
        status: 'FAILED_COLLECTION',
        visibility: null,
        response_rank: null,
      },
    ]);
    await repository.markRunRunning(p.id, run.id);
    expect((await repository.getRun(p.id, run.id))?.status).toBe('failed');
  });
  it('writes every identified company to native reporting rows with evidence, nullable unknown scores and citation provenance', async () => {
    const project = newProject({
      id: 'reporting-companies',
      prompts: ['Which analytics company should I use?'],
    });
    project.competitors = project.competitors.filter(
      (brand) => brand.name !== 'Metriclane',
    );
    project.prompts[0].intent = 'commercial';
    project.prompts[0].stage = 'prefer';
    await repository.saveProject(project, null);
    const artifacts = new MemoryArtifacts(),
      queue = new MemoryQueue(),
      provider = new FixtureProvider();
    const scanner = new Scanner({ repository, artifacts, queue, provider });
    await scanner.handle({
      kind: 'kickoff',
      projectId: project.id,
      scheduledAt: new Date().toISOString(),
      trigger: 'manual',
    });
    while (queue.messages.length) await scanner.handle(queue.messages.shift()!);
    const run = (await repository.listRuns(project.id))[0];
    const result = (await repository.listResults(project.id, run.id))[0];
    const answer = (await artifacts.get<import('@citevia/core').CapturedAnswer>(
      result.captureKey!,
    ))!;
    const analysis = (await artifacts.get<import('@citevia/core').Analysis>(
      result.analysisKey!,
    ))!;
    const block = answer.blocks.find((b) => b.text.includes('Metriclane'))!;
    const start = block.text.indexOf('Metriclane');
    analysis.companies = [
      {
        name: 'Metriclane',
        rank: 3,
        evidence: {
          blockId: block.id,
          start,
          end: start + 10,
          quote: 'Metriclane',
        },
      },
    ];
    await repository.saveMeasurement(result, run, answer, analysis);
    await repository.saveMeasurement(result, run, answer, analysis);
    const row = (
      await db.query(
        'SELECT json_response,sources FROM prompt_responses WHERE account_id=$1',
        [uuidFor(project.id)],
      )
    ).rows[0];
    expect((row.json_response as any).companies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          company: 'Metriclane',
          rank: 3,
          sentimentScore: null,
          feel: 'unknown',
        }),
      ]),
    );
    expect(
      (row.sources as any[]).every(
        (source) => typeof source.domain === 'string',
      ),
    ).toBe(true);
    const native = (
      await db.query(
        'SELECT rank,feel,prompt_type FROM results WHERE account_id=$1 AND entity=$2',
        [uuidFor(project.id), 'Metriclane'],
      )
    ).rows;
    expect(native).toEqual([
      { rank: 3, feel: 'unknown', prompt_type: 'commercial' },
    ]);
    expect(
      (
        await db.query('SELECT type,stage FROM prompts WHERE account_id=$1', [
          uuidFor(project.id),
        ])
      ).rows,
    ).toEqual([{ type: 'commercial', stage: 'prefer' }]);
  });
});
