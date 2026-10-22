import { DEFAULT_AGENT_CONTENT_MODEL } from '@citevia/core';

/** Astra requires reasoning; low keeps the existing interactive caption/blog workflow bounded. */
export function agentReasoning(model: string): { reasoningEffort?: 'low' } {
  return model === DEFAULT_AGENT_CONTENT_MODEL
    ? { reasoningEffort: 'low' }
    : {};
}
