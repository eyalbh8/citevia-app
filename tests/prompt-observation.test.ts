import { describe, expect, it } from 'vitest';
import type { PromptResult, ScanRun } from '@citevia/core';
import { newProject } from './fixtures/scanner.js';
import { promptObservation } from '../apps/client/src/prompt-observation.js';

function observation() {
  const project = newProject({
    id: 'test-account',
    prompts: ['Which product should a buyer compare?'],
  });
  const prompt = project.prompts[0];
  const snapshot = {
    ...project,
    projectName: project.name,
    configVersion: project.version,
  };
  const run: ScanRun = {
    id: 'run-one',
    projectId: project.id,
    snapshot,
    scheduledAt: project.createdAt,
    createdAt: project.createdAt,
    status: 'partial',
    trigger: 'manual',
    totalCount: 1,
    terminalCount: 1,
    succeededCount: 0,
    capturedCount: 1,
    resultVersion: 1,
    deadlineAt: project.createdAt,
    expiresAt: 0,
  };
  const result = {
    projectId: project.id,
    runId: run.id,
    promptId: prompt.id,
    prompt,
    status: 'failed_extraction',
    capturedAt: project.createdAt,
    citationCount: 2,
  } as PromptResult;
  return { project, prompt, run, result };
}

describe('prompt measurement provenance', () => {
  it('preserves the actual result status and native citation count, including analysis failures', () => {
    const { project, prompt, run, result } = observation();
    expect(promptObservation(prompt, project, run, result)).toBe(result);
    expect(promptObservation(prompt, project, run)).toBeUndefined();
    expect(promptObservation(prompt, project, null, result)).toBeUndefined();
  });
  it('does not attach an older answer to an edited version, another scan or another account', () => {
    const { project, prompt, run, result } = observation();
    expect(
      promptObservation({ ...prompt, version: 2 }, project, run, result),
    ).toBeUndefined();
    expect(
      promptObservation(
        { ...prompt, text: 'A new question?' },
        project,
        run,
        result,
      ),
    ).toBeUndefined();
    expect(
      promptObservation(prompt, project, run, {
        ...result,
        runId: 'other-run',
      }),
    ).toBeUndefined();
    expect(
      promptObservation(prompt, project, run, {
        ...result,
        projectId: 'other-account',
      }),
    ).toBeUndefined();
  });
  it('requires unchanged brand, locale and model settings before displaying measurements as current', () => {
    const { project, prompt, run, result } = observation();
    expect(
      promptObservation(
        prompt,
        { ...project, generationModel: 'changed-model' },
        run,
        result,
      ),
    ).toBeUndefined();
    expect(
      promptObservation(
        prompt,
        { ...project, brand: { ...project.brand, aliases: ['Changed alias'] } },
        run,
        result,
      ),
    ).toBeUndefined();
    expect(
      promptObservation(prompt, { ...project, country: 'DE' }, run, result),
    ).toBeUndefined();
  });
});
