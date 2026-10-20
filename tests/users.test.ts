import { afterEach, describe, expect, it } from 'vitest';
import type { Repository } from '@citevia/storage';
import {
  MemoryRepository,
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { testIdentity } from './fixtures/users.js';
import { newProject } from './fixtures/scanner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(kind: string) {
  let repository: Repository;
  if (kind === 'PostgreSQL') {
    const db = await localPostgres();
    repository = new PostgresRepository(db);
    cleanups.push(() => db.close());
  } else repository = new MemoryRepository();
  const admin = await repository.syncUser(testIdentity('admin'));
  await repository.bootstrapAdmin(admin.id);
  const viewer = await repository.syncUser(testIdentity('viewer'));
  const owner = await repository.syncUser(testIdentity('owner'));
  const alpha = newProject({
      id: 'alpha',
      name: 'Alpha',
      prompts: ['A buyer question for Alpha?'],
    }),
    beta = newProject({
      id: 'beta',
      name: 'Beta',
      prompts: ['A buyer question for Beta?'],
    });
  await repository.saveProject(alpha, null);
  await repository.saveProject(beta, null);
  await repository.putMembership({
    projectId: alpha.id,
    userId: viewer.subject,
    role: 'viewer',
  });
  await repository.putMembership({
    projectId: beta.id,
    userId: owner.subject,
    role: 'owner',
  });
  const api = createApi(
    { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() },
    {
      mode: 'live',
      lookupUser: async (email) => {
        if (email !== 'imported@test.example')
          throw new Error('Unexpected lookup');
        return testIdentity('imported');
      },
    },
  );
  const call = (
    subject: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ) =>
    api(
      new Request(`https://app.test/v1${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
      testIdentity(subject),
    );
  return { repository, admin, viewer, owner, call };
}

describe.each(['Memory', 'PostgreSQL'])(
  '%s users and account authorization',
  (kind) => {
    it('persists actual identity fields with no access by default and preserves administrator status on profile refresh', async () => {
      const f = await setup(kind),
        identity = {
          ...testIdentity('new-user'),
          email: 'Real.Profile@Test.Example',
          name: 'Actual supplied name',
          lastName: 'Family',
        };
      const user = await f.repository.syncUser(identity);
      expect(user).toMatchObject({
        email: 'real.profile@test.example',
        name: 'Actual supplied name',
        lastName: 'Family',
        isSystemAdmin: false,
        disabled: false,
      });
      expect(
        (
          await f.repository.listProjectSummaries(user.subject, {
            offset: 0,
            limit: 25,
          })
        ).items,
      ).toEqual([]);
      await expect(
        f.repository.syncUser({
          ...testIdentity('different-identity'),
          email: identity.email,
        }),
      ).rejects.toThrow('already linked');
      await f.repository.syncUser({
        ...testIdentity('admin'),
        name: 'Refreshed administrator name',
      });
      expect((await f.repository.getUser('admin'))?.isSystemAdmin).toBe(true);
      expect(
        (
          await f.repository.listUsers({
            offset: 0,
            limit: 25,
            query: 'supplied',
          })
        ).total,
      ).toBe(1);
    });
    it('shows assigned accounts to users and every account to system administrators, across all project endpoints', async () => {
      const f = await setup(kind);
      expect(
        (await (await f.call('viewer', '/projects')).json()).items.map(
          (p: { id: string }) => p.id,
        ),
      ).toEqual(['alpha']);
      expect(
        new Set(
          (await (await f.call('admin', '/projects')).json()).items.map(
            (p: { id: string }) => p.id,
          ),
        ),
      ).toEqual(new Set(['alpha', 'beta']));
      expect(
        (await (await f.call('unassigned', '/projects')).json()).items,
      ).toHaveLength(0);
      for (const tail of [
        'settings',
        'prompts',
        'dashboard',
        'runs',
        'responses',
        'sources',
        'brandbook',
        'onboarding',
        'responses/foreign~prompt',
        'sources/foreign/responses',
      ]) {
        expect(
          (await f.call('viewer', `/projects/beta/${tail}`)).status,
          tail,
        ).toBe(404);
        expect(
          (await f.call('unassigned', `/projects/alpha/${tail}`)).status,
          tail,
        ).toBe(404);
      }
      expect((await f.call('admin', '/projects/beta/settings')).status).toBe(
        200,
      );
      expect(
        (
          await f.call('viewer', '/projects/alpha/prompts', 'POST', {
            text: 'A forbidden viewer edit?',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call('owner', '/projects/beta/prompts', 'POST', {
            text: 'An allowed owner edit?',
            stage: 'trust',
          })
        ).status,
      ).toBe(201);
      expect(
        (await f.call('owner', '/onboarding/accounts', 'POST', {})).status,
      ).toBe(403);
      expect((await f.call('viewer', '/admin/users')).status).toBe(403);
      expect(
        (
          await f.call('viewer', `/admin/users/${f.viewer.id}`, 'PATCH', {
            version: 1,
            isSystemAdmin: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call(
            'viewer',
            `/admin/users/${f.owner.id}/accounts/alpha`,
            'PUT',
            { version: 1, role: 'owner' },
          )
        ).status,
      ).toBe(403);
    });
    it('imports verified identities and changes, revokes and disables access without relying on session roles', async () => {
      const f = await setup(kind);
      const imported = await f.call('admin', '/admin/users/import', 'POST', {
        email: 'imported@test.example',
      });
      expect(imported.status).toBe(201);
      const { user } = await imported.json();
      expect(user.isSystemAdmin).toBe(false);
      const assigned = await f.call(
        'admin',
        `/admin/users/${user.id}/accounts/alpha`,
        'PUT',
        { version: user.version, role: 'viewer' },
      );
      const assignedUser = (await assigned.json()).user;
      expect(assigned.status).toBe(200);
      expect(
        (await f.call('imported', '/projects/alpha/settings')).status,
      ).toBe(200);
      const stale = await f.call(
        'admin',
        `/admin/users/${user.id}/accounts/beta`,
        'PUT',
        { version: user.version, role: 'viewer' },
      );
      expect(stale.status).toBe(409);
      const removed = await f.call(
        'admin',
        `/admin/users/${user.id}/accounts/alpha`,
        'DELETE',
        { version: assignedUser.version },
      );
      const removedUser = (await removed.json()).user;
      expect(
        (await f.call('imported', '/projects/alpha/settings')).status,
      ).toBe(404);
      await f.call('admin', `/admin/users/${user.id}`, 'PATCH', {
        version: removedUser.version,
        disabled: true,
      });
      for (const path of ['/me', '/projects', '/runtime', '/admin/users'])
        expect((await f.call('imported', path)).status).toBe(403);
      const access = await (
        await f.call('admin', `/admin/users/${user.id}`)
      ).json();
      expect(access.accounts).toHaveLength(0);
    });
    it('keeps bootstrap explicit and protects administrator changes and concurrent assignment writes', async () => {
      const f = await setup(kind);
      await expect(f.repository.bootstrapAdmin(f.owner.id)).rejects.toThrow();
      expect(
        (
          await f.call('admin', `/admin/users/${f.admin.id}`, 'PATCH', {
            version: 2,
            isSystemAdmin: false,
          })
        ).status,
      ).toBe(409);
      const viewer = (await f.repository.getUser('viewer'))!;
      const changes = await Promise.all(
        ['alpha', 'beta'].map((project) =>
          f.call(
            'admin',
            `/admin/users/${viewer.id}/accounts/${project}`,
            'PUT',
            { version: viewer.version, role: 'owner' },
          ),
        ),
      );
      expect(changes.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await f.repository.getUser('viewer'))?.isSystemAdmin).toBe(false);
    });
  },
);
