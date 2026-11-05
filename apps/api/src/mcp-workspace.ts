import { uuidFor } from '@citevia/storage';

/** Use the existing public account UUID for handles containing legacy account-type labels. */
export function mcpWorkspaceId(projectId: string | null): string | null {
  return projectId && /demo/i.test(projectId) ? uuidFor(projectId) : projectId;
}
