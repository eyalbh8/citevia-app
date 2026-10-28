import { analysisProvider, DEFAULT_ANALYSIS_MODEL } from '@citevia/core';
import type { Repository } from '@citevia/storage';

export interface ConfigureAnalysisOptions {
  model?: string;
  project?: string;
  apply?: boolean;
}

/** Only live project configuration changes. Run snapshots and collection models are never edited. */
export async function configureAnalysis(
  repository: Pick<Repository, 'getProject' | 'saveProject'>,
  projectIds: string[],
  options: ConfigureAnalysisOptions = {},
  now = new Date(),
) {
  const model = options.model ?? DEFAULT_ANALYSIS_MODEL;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(model)) throw new Error('Choose a valid analysis model ID.');
  const changes = [];
  for (const id of new Set(projectIds)) {
    if (options.project && id !== options.project) continue;
    const project = await repository.getProject(id);
    if (!project) {
      changes.push({ projectId: id, status: 'missing' });
      continue;
    }
    if (!options.project && analysisProvider(project.extractionModel) === 'gemini') continue;
    if (project.extractionModel === model) {
      changes.push({ projectId: id, from: project.extractionModel, to: model, status: 'unchanged', version: project.version });
      continue;
    }
    const next = { ...project, extractionModel: model, version: project.version + 1, updatedAt: now.toISOString() };
    const saved = options.apply ? await repository.saveProject(next, project.version) : null;
    changes.push({
      projectId: id, from: project.extractionModel, to: model,
      status: !options.apply ? 'planned' : saved ? 'updated' : 'conflict',
      expectedVersion: project.version, nextVersion: next.version,
    });
  }
  return {
    mode: options.apply ? 'apply' : 'preview',
    scope: options.project ?? 'accounts using non-Gemini analysis models',
    model,
    appliesTo: 'Future scan analysis. Existing run snapshots and collection/content models retain their saved settings.',
    rollout: 'Evaluate labelled saved answers and provider access before applying the model choice.',
    updated: changes.filter((change) => change.status === 'updated').length,
    conflicts: changes.filter((change) => change.status === 'conflict').length,
    changes,
  };
}
