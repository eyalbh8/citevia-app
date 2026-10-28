import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User, VerifiedIdentity } from '@citevia/core';
import {
  MemoryArtifacts,
  MemoryQueue,
  PostgresRepository,
  uuidFor,
  type SqlDatabase,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { newProject } from './fixtures/scanner.js';
import { testIdentity } from './fixtures/users.js';

let db: SqlDatabase, repository: PostgresRepository;
const createdAt = '2024-01-02T03:04:05.000Z';

beforeAll(async () => {
  db = await localPostgres();
  repository = new PostgresRepository(db);
}, 30000);
afterAll(async () => {
  await db?.close();
});

async function unlinkedUser(key: string, admin = false) {
  const id = uuidFor(`unlinked:${key}`), email = `${key}@test.example`;
  await db.query(
    `INSERT INTO users(id,email,name,last_name,is_system_admin,created_at,updated_at)
     VALUES($1,$2,'Saved name','Saved family',$3,$4,$4)`,
    [id, email, admin, createdAt],
  );
  return { id, email };
}

describe('linking verified Descope identities to existing database users', () => {
  it('links /me to the existing UUID and preserves administrator access, timestamps and account assignments', async () => {
    const saved = await unlinkedUser('saved-administrator', true);
    await db.query('UPDATE users SET email=$2 WHERE id=$1', [
      saved.id, saved.email.toUpperCase(),
    ]);
    const project = newProject({ id: 'identity-link-account', prompts: ['Which platform?'] });
    await repository.saveProject(project, null);
    const membershipId = uuidFor('saved-identity-membership');
    await db.query(
      `INSERT INTO user_accounts(id,user_id,account_id,roles,created_at,updated_at)
       VALUES($1,$2,$3,ARRAY['OWNER'],$4,$4)`,
      [membershipId, saved.id, uuidFor(project.id), createdAt],
    );
    const identity: VerifiedIdentity = {
      ...testIdentity('verified-saved-administrator'),
      email: `  ${saved.email.toUpperCase()}  `,
      name: 'Verified name',
      lastName: 'Verified family',
    };
    const api = createApi(
      { repository, artifacts: new MemoryArtifacts(), queue: new MemoryQueue() },
      { mode: 'live' },
    );
    const result = await api(new Request('https://test/v1/me'), identity);
    expect(result.status).toBe(200);
    const user = await result.json() as User;
    expect(user).toMatchObject({
      id: saved.id,
      subject: identity.subject,
      descopeUserId: identity.externalUserId,
      email: saved.email,
      name: 'Verified name',
      lastName: 'Verified family',
      isSystemAdmin: true,
      disabled: false,
      createdAt,
    });
    expect(user.lastSeenAt).not.toBeNull();
    expect(await repository.getMembership(project.id, identity.subject)).toEqual({
      projectId: project.id, userId: identity.subject, role: 'owner',
    });
    expect((await db.query('SELECT id,user_id,created_at FROM user_accounts WHERE id=$1', [membershipId])).rows)
      .toEqual([{ id: membershipId, user_id: saved.id, created_at: new Date(createdAt) }]);
    expect((await api(new Request(`https://test/v1/projects/${project.id}/settings`), identity)).status)
      .toBe(200);

    const repeated = await Promise.all([
      repository.syncUser(identity, true), repository.syncUser(identity, true),
    ]);
    expect(repeated.map(value => value.id)).toEqual([saved.id, saved.id]);
    expect((await db.query('SELECT count(*)::int AS count FROM users WHERE lower(email)=$1', [saved.email])).rows[0].count)
      .toBe(1);
    expect((await db.query('SELECT subject FROM citevia_identities WHERE user_id=$1', [saved.id])).rows)
      .toEqual([{ subject: identity.subject }]);
  });

  it('allows only one of two competing subjects to claim the same unlinked email', async () => {
    const saved = await unlinkedUser('competing-identities');
    const identities = ['first-claim', 'second-claim'].map(subject => ({
      ...testIdentity(subject), email: saved.email,
    }));
    const results = await Promise.allSettled(identities.map(identity => repository.syncUser(identity)));
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ value: { id: saved.id } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { status: 409, code: 'IDENTITY_CONFLICT' } });
    expect((await db.query('SELECT count(*)::int AS count FROM users WHERE lower(email)=$1', [saved.email])).rows[0].count)
      .toBe(1);
    expect((await db.query('SELECT subject FROM citevia_identities WHERE user_id=$1', [saved.id])).rows)
      .toHaveLength(1);
  });

  it.each(['legacy', 'descope'])('does not replace an existing %s identity mapping', async provider => {
    const saved = await unlinkedUser(`mapped-${provider}`);
    const previousSubject = `previous-${provider}`, externalId = `provider-${provider}`;
    await db.query(
      `INSERT INTO citevia_identities(subject,user_id,provider,external_user_id,disabled,access_version)
       VALUES($1,$2,$3,$4,true,7)`,
      [previousSubject, saved.id, provider, provider === 'descope' ? externalId : null],
    );
    await expect(repository.syncUser({
      ...testIdentity(`replacement-${provider}`), email: saved.email,
    })).rejects.toMatchObject({ status: 409, code: 'IDENTITY_CONFLICT' });
    expect((await db.query('SELECT subject,provider,disabled,access_version FROM citevia_identities WHERE user_id=$1', [saved.id])).rows)
      .toEqual([{ subject: previousSubject, provider, disabled: true, access_version: 7 }]);
    expect((await db.query('SELECT name,last_name FROM users WHERE id=$1', [saved.id])).rows)
      .toEqual([{ name: 'Saved name', last_name: 'Saved family' }]);
  });

  it('rejects an unverified email before linking or refreshing the saved profile', async () => {
    const saved = await unlinkedUser('unverified-identity');
    await expect(repository.syncUser({
      ...testIdentity('unverified-provider-user'), email: saved.email, emailVerified: false,
    } as unknown as VerifiedIdentity)).rejects.toThrow();
    expect((await db.query('SELECT subject FROM citevia_identities WHERE user_id=$1', [saved.id])).rows)
      .toEqual([]);
    expect((await db.query('SELECT name,last_name FROM users WHERE id=$1', [saved.id])).rows)
      .toEqual([{ name: 'Saved name', last_name: 'Saved family' }]);
  });

  it('rolls back linking and profile changes when the Descope ID already belongs to another subject', async () => {
    const assigned = await repository.syncUser(testIdentity('assigned-provider-user'));
    const saved = await unlinkedUser('external-id-collision', true);
    await expect(repository.syncUser({
      ...testIdentity('new-collision-subject'),
      externalUserId: assigned.descopeUserId,
      email: saved.email,
      name: 'Must not persist',
    })).rejects.toMatchObject({ status: 409, code: 'IDENTITY_CONFLICT' });
    expect((await db.query('SELECT subject FROM citevia_identities WHERE user_id=$1', [saved.id])).rows)
      .toEqual([]);
    expect((await db.query('SELECT email,name,last_name,is_system_admin,created_at FROM users WHERE id=$1', [saved.id])).rows)
      .toEqual([{
        email: saved.email, name: 'Saved name', last_name: 'Saved family',
        is_system_admin: true, created_at: new Date(createdAt),
      }]);
    expect(await repository.getUser(assigned.subject)).toEqual(assigned);
  });
});
