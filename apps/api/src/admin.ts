import { z } from 'zod';
import {
  assignmentSchema,
  identifier,
  userAccessSchema,
  type User,
  type VerifiedIdentity,
} from '@citevia/core';
import { AccessError, type Repository } from '@citevia/storage';

export async function adminRoute(
  request: Request,
  path: string,
  query: URLSearchParams,
  context: {
    repository: Repository;
    user: User;
    lookup?: (email: string) => Promise<VerifiedIdentity>;
    body: (request: Request) => Promise<unknown>;
    paging: (query: URLSearchParams) => { offset: number; limit: number };
    json: (data: unknown, status?: number) => Response;
  },
): Promise<Response> {
  const { repository, user, lookup, body, paging, json } = context;
  if (!user.isSystemAdmin || user.disabled)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'System administrator access is required.',
    );
  if (path === '/v1/admin/users' && request.method === 'GET') {
    const q = z
      .string()
      .max(200)
      .parse(query.get('q') || '');
    return json(await repository.listUsers({ ...paging(query), query: q }));
  }
  if (path === '/v1/admin/users/import' && request.method === 'POST') {
    const input = z
      .object({ email: z.string().trim().toLowerCase().email().max(320) })
      .strict()
      .parse(await body(request));
    if (!lookup)
      throw new AccessError(
        503,
        'AUTH_NOT_CONFIGURED',
        'Descope lookup is not configured.',
      );
    return json(
      { user: await repository.syncUser(await lookup(input.email)) },
      201,
    );
  }
  const match = path.match(
    /^\/v1\/admin\/users\/([^/]+)(?:\/accounts\/([^/]+))?$/,
  );
  if (!match) throw new AccessError(404, 'NOT_FOUND', 'Endpoint not found');
  const id = z.string().uuid().parse(match[1]);
  const target = await repository.getUserById(id);
  if (!target) throw new AccessError(404, 'USER_NOT_FOUND', 'User not found');
  if (!match[2] && request.method === 'GET')
    return json({
      user: target,
      accounts: await repository.listUserAccounts(id),
    });
  if (!match[2] && request.method === 'PATCH') {
    const { version, ...input } = userAccessSchema.parse(await body(request));
    return json({
      user: await repository.updateUserAccess(user.subject, id, version, input),
    });
  }
  if (match[2] && ['PUT', 'DELETE'].includes(request.method)) {
    const projectId = identifier.parse(decodeURIComponent(match[2]));
    const input =
      request.method === 'PUT'
        ? assignmentSchema.parse(await body(request))
        : z
            .object({ version: z.number().int().positive() })
            .strict()
            .parse(await body(request));
    return json({
      user: await repository.setUserAccount(
        user.subject,
        id,
        projectId,
        'role' in input ? (input.role as 'owner' | 'viewer') : null,
        input.version,
      ),
      accounts: await repository.listUserAccounts(id),
    });
  }
  throw new AccessError(404, 'NOT_FOUND', 'Endpoint not found');
}
