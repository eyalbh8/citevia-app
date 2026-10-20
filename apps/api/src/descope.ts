import DescopeClient from '@descope/node-sdk';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { verifiedIdentitySchema, type VerifiedIdentity } from '@citevia/core';

export class AuthenticationError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
type Profile = {
  userId: string;
  email?: string;
  verifiedEmail?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  status: string;
  test?: boolean;
};
export interface DescopeAdapter {
  validate(
    token: string,
    audience: string,
  ): Promise<{ sub?: string; token_type?: unknown }>;
  user(
    id: string,
    byUserId: boolean,
  ): Promise<{ ok: boolean; code?: number; data?: Profile }>;
}
export interface IdentityProvider {
  authenticate(request: Request): Promise<VerifiedIdentity>;
  lookup(email: string): Promise<VerifiedIdentity>;
}
export class DescopeIdentityProvider implements IdentityProvider {
  constructor(
    private projectId: string,
    private load: () => Promise<DescopeAdapter>,
  ) {}
  private identity(profile: Profile): VerifiedIdentity {
    if (profile.status !== 'enabled' || !profile.verifiedEmail || profile.test)
      throw new AuthenticationError(
        403,
        'IDENTITY_NOT_ACTIVE',
        'Use an active Descope user with a verified email. Test identities are not accepted.',
      );
    const value = verifiedIdentitySchema.safeParse({
      provider: 'descope',
      subject: `descope:${this.projectId}:${profile.userId}`,
      externalUserId: profile.userId,
      email: profile.email,
      emailVerified: true,
      name: profile.givenName || profile.name || null,
      lastName: profile.familyName || null,
    });
    if (!value.success)
      throw new AuthenticationError(
        403,
        'INVALID_IDENTITY',
        'Descope did not return a valid user profile.',
      );
    return value.data;
  }
  async authenticate(request: Request): Promise<VerifiedIdentity> {
    const token = request.headers
      .get('authorization')
      ?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || token.length > 20000 || token.split('.').length !== 3)
      throw new AuthenticationError(
        401,
        'UNAUTHENTICATED',
        'Sign in through Descope to continue.',
      );
    const adapter = await this.load();
    let session: Awaited<ReturnType<DescopeAdapter['validate']>>;
    try {
      session = await adapter.validate(token, this.projectId);
    } catch {
      throw new AuthenticationError(
        401,
        'INVALID_SESSION',
        'Your Descope session is invalid or expired. Sign in again.',
      );
    }
    if (!session.sub || session.token_type === 'access_token')
      throw new AuthenticationError(
        401,
        'INVALID_SESSION',
        'A Descope user session is required.',
      );
    const profile = await adapter.user(session.sub, true);
    if (!profile.ok || !profile.data) {
      if (profile.code === 404)
        throw new AuthenticationError(
          401,
          'INVALID_SESSION',
          'The Descope user no longer exists.',
        );
      throw new AuthenticationError(
        503,
        'IDENTITY_UNAVAILABLE',
        'Descope user verification is temporarily unavailable.',
      );
    }
    if (profile.data.userId !== session.sub)
      throw new AuthenticationError(
        401,
        'INVALID_SESSION',
        'The session and profile do not match.',
      );
    return this.identity(profile.data);
  }
  async lookup(email: string): Promise<VerifiedIdentity> {
    const result = await (await this.load()).user(email, false);
    if (!result.ok || !result.data) {
      if (result.code === 404)
        throw new AuthenticationError(
          404,
          'USER_NOT_FOUND',
          'Create this user in Descope and verify their email before importing them.',
        );
      throw new AuthenticationError(
        503,
        'IDENTITY_UNAVAILABLE',
        'The Descope lookup could not be completed.',
      );
    }
    return this.identity(result.data);
  }
}

export function createDescopeIdentityProvider(): IdentityProvider {
  const projectId = process.env.DESCOPE_PROJECT_ID?.trim() || '';
  let cached: Promise<DescopeAdapter> | undefined,
    loadedAt = 0;
  const load = async (): Promise<DescopeAdapter> => {
    if (cached && Date.now() - loadedAt < 300_000) return cached;
    loadedAt = Date.now();
    cached = (async () => {
      let managementKey = process.env.DESCOPE_MANAGEMENT_KEY?.trim();
      if (!managementKey && process.env.DESCOPE_SECRET_ARN) {
        const secret = await new SecretsManagerClient({}).send(
          new GetSecretValueCommand({
            SecretId: process.env.DESCOPE_SECRET_ARN,
          }),
        );
        try {
          managementKey = JSON.parse(
            secret.SecretString || '{}',
          ).DESCOPE_MANAGEMENT_KEY;
        } catch {
          managementKey = secret.SecretString;
        }
      }
      if (!projectId || !managementKey)
        throw new AuthenticationError(
          503,
          'AUTH_NOT_CONFIGURED',
          'Configure the Descope project and server management key.',
        );
      const baseUrl = process.env.DESCOPE_BASE_URL || 'https://api.descope.com';
      if (!/^https:\/\//.test(baseUrl))
        throw new AuthenticationError(
          503,
          'AUTH_NOT_CONFIGURED',
          'Descope requires an HTTPS base URL.',
        );
      const sdk = DescopeClient({ projectId, managementKey, baseUrl });
      return {
        validate: async (token: string, audience: string) =>
          (await sdk.validateSession(token, { audience })).token,
        user: async (id: string, byUserId: boolean) => {
          const result = await (byUserId
            ? sdk.management.user.loadByUserId(id)
            : sdk.management.user.load(id));
          return { ok: result.ok, code: result.code, data: result.data };
        },
      };
    })().catch(() => {
      cached = undefined;
      throw new AuthenticationError(
        503,
        'AUTH_NOT_CONFIGURED',
        'Descope verification is unavailable. Check server configuration and secret access.',
      );
    });
    return cached;
  };
  return new DescopeIdentityProvider(projectId, load);
}

export function authenticationFailure(error: unknown): Response {
  const known = error instanceof AuthenticationError;
  return new Response(
    JSON.stringify({
      error: {
        code: known ? error.code : 'IDENTITY_UNAVAILABLE',
        message: known
          ? error.message
          : 'Identity verification is temporarily unavailable.',
      },
    }),
    {
      status: known ? error.status : 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
