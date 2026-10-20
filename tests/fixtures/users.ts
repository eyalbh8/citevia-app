import type { VerifiedIdentity } from '@citevia/core';
if (process.env.NODE_ENV !== 'test')
  throw new Error('Test fixtures cannot be used by the application.');
export function testIdentity(subject: string): VerifiedIdentity {
  return {
    provider: 'descope',
    subject,
    externalUserId: subject,
    email: `${subject}@test.example`,
    emailVerified: true,
    name: subject,
    lastName: null,
  };
}
