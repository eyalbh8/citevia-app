import {
  sameTargetMethod,
  projectProviders,
  snapshotProvider,
} from '@citevia/core';
import type { Project, Prompt, PromptResult, ScanRun } from '@citevia/core';

/** An older answer must never become a measurement of an edited prompt. */
export function promptObservation(
  prompt: Prompt,
  project: Project,
  run: ScanRun | null | undefined,
  result?: PromptResult,
) {
  if (
    !run ||
    !result ||
    result.runId !== run.id ||
    result.projectId !== project.id ||
    result.promptId !== prompt.id ||
    result.prompt.version !== prompt.version ||
    result.prompt.text !== prompt.text
  )
    return undefined;
  if (
    !sameTargetMethod(run.snapshot, {
      ...run.snapshot,
      brand: project.brand,
      competitors: project.competitors,
      generationModel:
        projectProviders(project).find(
          (config) => config.provider === snapshotProvider(run.snapshot),
        )?.model ?? '',
      extractionModel: project.extractionModel,
      parserVersion: project.parserVersion,
      country: project.country,
      language: project.language,
    })
  )
    return undefined;
  return result;
}
