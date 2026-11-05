import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasRestrictedWord, publicReportId, resolveReportId } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import { publicReportValue, restoreReportFields } from '../apps/api/src/public-report.js';
import { buildServiceDemo } from '../scripts/create-service-demo.js';
import { testIdentity } from './fixtures/users.js';

const now = () => new Date('2026-11-05T12:00:00Z');
const source = JSON.parse(readFileSync(new URL('../scripts/demo-sources/etoro.json', import.meta.url), 'utf8'));

describe('public account reports', () => {
  it('can follow public account, prompt, scan and answer handles without changing tenant scope', async () => {
    const repository = new MemoryRepository();
    const project = buildServiceDemo(source, now().toISOString());
    await repository.saveProject(project, null);
    await repository.syncUser(testIdentity('member'));
    await repository.putMembership({ projectId: project.id, userId: 'member', role: 'viewer' });
    const api = createAuthenticatedApi({ repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() }, {
      authenticate: async request => testIdentity(request.headers.get('x-user') || 'member'),
      lookup: async email => testIdentity(email.split('@')[0]),
    }, { mode: 'live', now });
    const get = async (path: string) => {
      const response = await api(new Request('https://api.test/v1/projects' + path));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(hasRestrictedWord(text)).toBe(false);
      return JSON.parse(text);
    };
    const index = await get('');
    const id = index.items[0].id;
    expect(id).toBe(publicReportId(project.id));
    const settings = await get('/' + id + '/settings');
    expect(settings.reportingProfile.source).toBe('website-history');
    expect(settings.reportingProfile).not.toHaveProperty('samples');
    const prompt = settings.prompts[0].id;
    const history = await get('/' + id + '/prompts/' + prompt + '/responses?days=7&limit=1');
    const result = await get('/' + id + '/responses/' + history.items[0].responseId);
    const run = await get('/' + id + '/runs/' + result.run.id);
    expect(run.id).toBe(result.run.id);
    const responses = await get('/' + id + '/responses?runId=' + run.id);
    expect(responses.items.some((item: { responseId: string }) => item.responseId === history.items[0].responseId)).toBe(true);
    expect((await api(new Request('https://api.test/v1/projects/' + id + '/settings', { headers: { 'x-user': 'outsider' } }))).status).toBe(404);
    expect((await repository.getProject(project.id))?.demo?.samples).toEqual(project.demo?.samples);
  });
  it('preserves original evidence when an unrelated edit submits the public representation', () => {
    const saved = { title: 'My demo account', knowledgeSources: ['https://bank.test/practice', 'https://bank.test/demo'] };
    const visible = publicReportValue(saved) as typeof saved;
    expect(visible.knowledgeSources).toEqual(['https://bank.test/practice']);
    expect(restoreReportFields({ ...visible, description: 'New copy' }, saved)).toEqual({ ...saved, description: 'New copy' });
    expect(() => restoreReportFields({ ...visible, knowledgeSources: [] }, saved)).toThrow('withheld material');
    expect(publicReportValue('https://bank.test/practice?utm_source=demo')).toBe('https://bank.test/practice');
  });
  it('marks shortened answers, drops blocked destinations, and keeps provider envelopes private', () => {
    const original = { answer: { text: 'A Demo account', blocks: [{ id: 'answer', text: 'A Demo account' }],
      citations: [{ url: 'https://bank.test/demo', title: 'Broker' }], sources: [], raw: { output: 'Raw demo', binary: 'ZGVtbw==' } } };
    expect(publicReportValue(original)).toMatchObject({ answer: { isExcerpt: true, text: 'A […] account', citations: [], raw: {} } });
    expect(original.answer.text).toBe('A Demo account');
    expect(resolveReportId(publicReportId('cvh_64656d6f~old_demo_id'))).toBe('cvh_64656d6f~old_demo_id');
  });
});
