import { createHash } from 'node:crypto';
import type { OnboardingJob, Project, Prompt } from '@citevia/core';
import type { Runtime } from '@citevia/storage';
import {
  OnboardingOutputError,
  validatePortfolio,
  type OnboardingProvider,
} from './onboarding-provider.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contextHash = (project: Project) =>
  hash([project.brandbook, project.brand, project.country, project.language]);
export function replacePortfolio(
  project: Project,
  prompts: Prompt[],
  at: string,
): Prompt[] {
  const active = project.prompts.filter((p) => p.active);
  const updated = prompts.map((prompt, i) => ({
    ...prompt,
    id: active[i]?.id || prompt.id,
    version: active[i] ? active[i].version + 1 : 1,
    createdAt: active[i]?.createdAt || at,
    updatedAt: at,
  }));
  return [...project.prompts.filter((p) => !p.active).slice(-50), ...updated];
}

/** IAM-only maintenance: reuses the saved brandbook, versions prompts, never starts scans. */
export async function refreshPortfolio(
  runtime: Runtime,
  provider: Pick<OnboardingProvider, 'prompts'>,
  projectId: string,
  requestId: string,
  now = () => new Date(),
) {
  const { repository, artifacts } = runtime;
  let project = await repository.getProject(projectId);
  if (!project?.brandbook)
    throw new Error('A completed, saved brandbook is required.');
  const id = `portfolio_${hash([projectId, requestId]).slice(0, 32)}`;
  const key = `projects/${projectId}/portfolios/${id}/prompts.json`;
  if (
    project.portfolioRefresh?.id === id &&
    project.portfolioRefresh.status === 'completed'
  )
    return { projectId, refreshed: true, reused: true, scanStarted: false };
  let saved = await artifacts.get<{ prompts: Prompt[]; receipt: unknown }>(key);
  if (project.portfolioRefresh?.id === id) {
    if (!saved)
      throw new Error(
        'The previous generation has no saved checkpoint. Calls stopped to avoid duplicate charges; inspect it before using a new request ID.',
      );
  } else {
    if (project.portfolioRefresh?.status === 'generating')
      throw new Error('Another portfolio generation is in progress.');
    const reserved: Project = {
      ...project,
      version: project.version + 1,
      portfolioRefresh: {
        id,
        status: 'generating',
        requestedAt: now().toISOString(),
        promptHash: hash(project.prompts),
        brandbookHash: contextHash(project),
      },
    };
    if (!(await repository.saveProject(reserved, project.version)))
      throw new Error('Account changed; refresh and try again.');
    project = reserved;
  }
  const job: OnboardingJob = {
    id,
    projectId,
    ownerId: '',
    requestId,
    inputHash: hash(project.brandbook),
    retryRequestIds: [],
    input: {
      name: project.brand.name,
      website: `https://${project.brand.domains[0]}`,
      country: project.country,
      language: project.language,
      timezone: project.timezone,
      description: '',
      manualPrompts: [],
    },
    status: 'running',
    step: 'prompts',
    attempts: 0,
    version: 1,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    deadlineAt: new Date(now().getTime() + 15 * 60_000).toISOString(),
  };
  try {
    if (!saved) {
      saved = await provider.prompts(job, project.brandbook!);
      await artifacts.put(key, saved);
    }
    const latest = await repository.getProject(projectId);
    if (
      !latest ||
      latest.portfolioRefresh?.id !== id ||
      hash(latest.prompts) !== latest.portfolioRefresh.promptHash ||
      contextHash(latest) !== latest.portfolioRefresh.brandbookHash
    )
      throw new Error(
        'Prompts or brandbook changed during generation; saved output needs review before applying.',
      );
    const validated = validatePortfolio(job, latest.brandbook!, {
      prompts: saved.prompts.map(({ text, stage, topic, branded, intent }) => ({
        text,
        stage,
        topic,
        branded,
        intent,
      })),
    });
    const at = now().toISOString();
    const next: Project = {
      ...latest,
      prompts: replacePortfolio(latest, validated, at),
      version: latest.version + 1,
      updatedAt: at,
      portfolioRefresh: { ...latest.portfolioRefresh, status: 'completed' },
    };
    if (!(await repository.saveProject(next, latest.version)))
      throw new Error(
        'Account changed before applying; retry the same request ID to reuse the checkpoint.',
      );
    return {
      projectId,
      refreshed: true,
      promptCount: saved.prompts.length,
      brandedCount: saved.prompts.filter((p) => p.branded).length,
      scanStarted: false,
    };
  } catch (error) {
    if (error instanceof OnboardingOutputError) {
      await artifacts
        .put(
          `projects/${projectId}/portfolios/${id}/failed-receipt.json`,
          error.receipt,
        )
        .catch(() => {});
    }
    const latest = await repository.getProject(projectId);
    if (
      latest?.portfolioRefresh?.id === id &&
      latest.portfolioRefresh.status !== 'completed'
    )
      await repository.saveProject(
        {
          ...latest,
          version: latest.version + 1,
          portfolioRefresh: {
            ...latest.portfolioRefresh,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Generation failed',
          },
        },
        latest.version,
      );
    throw error;
  }
}
