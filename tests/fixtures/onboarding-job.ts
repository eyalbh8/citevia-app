import type { OnboardingJob } from '@citevia/core';
if (process.env.NODE_ENV !== 'test')
  throw new Error('Test fixtures cannot be used by the application.');
export const policyJob = (): OnboardingJob => ({
  id: 'policy-job',
  projectId: 'policy-account',
  ownerId: 'owner',
  requestId: 'policy-request',
  inputHash: 'hash',
  input: {
    name: 'Acme',
    website: 'https://acme.com',
    country: 'IT',
    language: 'en',
    timezone: 'UTC',
    description: '',
    manualPrompts: [],
  },
  status: 'running',
  step: 'prompts',
  version: 1,
  attempts: 0,
  retryRequestIds: [],
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  deadlineAt: '2026-10-22T00:00:00.000Z',
});
