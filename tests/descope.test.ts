import { describe, expect, it, vi } from 'vitest';
import {
  DescopeIdentityProvider,
  AuthenticationError,
  type DescopeAdapter,
} from '../apps/api/src/descope.js';
import { createAuthenticatedApi } from '../apps/api/src/handler.js';
import {
  MemoryArtifacts,
  MemoryQueue,
  MemoryRepository,
} from '@citevia/storage';
import { parseScanMessage } from '../apps/scanner/src/handler.js';
import { parseAdminArgs } from '../scripts/admin-bootstrap.js';

const request = (token = 'header.payload.signature') =>
  new Request('https://test/v1/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
function environment() {
  const profile = {
    userId: 'real-provider-id',
    email: 'person@test.example',
    verifiedEmail: true,
    name: 'Verified profile',
    status: 'enabled',
    test: false,
  };
  const validate = vi.fn(async () => ({
    sub: profile.userId,
    roles: ['system_admin'],
  }));
  const user = vi.fn(async () => ({ ok: true, data: profile }));
  const adapter: DescopeAdapter = { validate, user },
    provider = new DescopeIdentityProvider('project-id', async () => adapter);
  return { profile, validate, user, provider };
}
describe('Descope authentication boundary', () => {
  it('answers the browser preflight before requiring a session', async () => {
    const f = environment();
    const app = createAuthenticatedApi(
      {
        repository: new MemoryRepository(),
        queue: new MemoryQueue(),
        artifacts: new MemoryArtifacts(),
      },
      f.provider,
      { mode: 'live' },
    );
    const response = await app(
      new Request('https://test/v1/me', { method: 'OPTIONS' }),
    );
    expect(response.status).toBe(204);
    expect(f.validate).not.toHaveBeenCalled();
  });
  it('validates the project audience, loads the matching profile server-side and ignores token roles', async () => {
    const f = environment(),
      repository = new MemoryRepository();
    const app = createAuthenticatedApi(
      {
        repository,
        queue: new MemoryQueue(),
        artifacts: new MemoryArtifacts(),
      },
      f.provider,
      { mode: 'live' },
    );
    const result = await app(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      email: f.profile.email,
      name: f.profile.name,
      isSystemAdmin: false,
      subject: 'descope:project-id:real-provider-id',
    });
    expect(f.validate).toHaveBeenCalledWith(
      'header.payload.signature',
      'project-id',
    );
    expect(f.user).toHaveBeenCalledWith(f.profile.userId, true);
    const blocked = await app(
      new Request('https://test/v1/admin/users', {
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'X-System-Admin': 'true',
        },
      }),
    );
    expect(blocked.status).toBe(403);
  });
  it('rejects local development tokens, invalid signatures and expired/wrong-project sessions without creating users', async () => {
    const f = environment(),
      repository = new MemoryRepository();
    const app = createAuthenticatedApi(
      {
        repository,
        queue: new MemoryQueue(),
        artifacts: new MemoryArtifacts(),
      },
      f.provider,
      { mode: 'live' },
    );
    for (const token of ['local-development', '', 'invalid'])
      expect((await app(request(token))).status).toBe(401);
    f.validate.mockRejectedValue(new Error('JWT verification failed'));
    expect((await app(request())).status).toBe(401);
    expect(f.user).not.toHaveBeenCalled();
    expect((await repository.listUsers({ offset: 0, limit: 25 })).total).toBe(
      0,
    );
  });
  it('rejects mismatched, unverified, inactive, test and machine identities', async () => {
    for (const changes of [
      { userId: 'different' },
      { verifiedEmail: false },
      { status: 'disabled' },
      { test: true },
    ]) {
      const f = environment();
      Object.assign(f.profile, changes);
      // Keep the session subject stable to check a mismatched management response.
      f.validate.mockResolvedValue({ sub: 'real-provider-id', roles: [] });
      await expect(f.provider.authenticate(request())).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    }
    const f = environment();
    f.validate.mockResolvedValue({
      sub: 'real-provider-id',
      token_type: 'access_token',
    } as never);
    await expect(f.provider.authenticate(request())).rejects.toMatchObject({
      status: 401,
    });
  });
  it('fails closed on provider outages and keeps maintenance events out of the scan queue', async () => {
    const f = environment();
    f.user.mockRejectedValue(new Error('Provider unavailable'));
    const app = createAuthenticatedApi(
      {
        repository: new MemoryRepository(),
        queue: new MemoryQueue(),
        artifacts: new MemoryArtifacts(),
      },
      f.provider,
      { mode: 'live' },
    );
    expect((await app(request())).status).toBe(503);
    expect(() =>
      parseScanMessage({
        kind: 'users:bootstrap-admin',
        userId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toThrow();
    expect(() =>
      parseAdminArgs([
        '--local',
        '--stack',
        'prod',
        '--user-id',
        '00000000-0000-4000-8000-000000000000',
      ]),
    ).toThrow();
    expect(() =>
      parseAdminArgs(['--local', '--user-id', 'not-an-id']),
    ).toThrow();
    expect(parseAdminArgs(['--help'])).toBeNull();
  });
});
