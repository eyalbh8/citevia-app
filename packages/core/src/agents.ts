import { z } from 'zod';
import type { Brand, Brandbook } from './types.js';

export const AGENT_CHANNELS = [
  'facebook',
  'instagram',
  'x',
  'pinterest',
  'reddit',
  'blog',
] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];
export const agentInputSchema = z
  .object({
    channel: z.enum(AGENT_CHANNELS),
    topic: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(4000),
    promptId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AgentInput = z.infer<typeof agentInputSchema>;
export const agentContentSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(30000),
    hashtags: z.array(z.string().trim().min(1).max(100)).max(15),
  })
  .strict();
export type AgentContent = z.infer<typeof agentContentSchema>;
export function agentPostText(channel: AgentChannel, content: AgentContent) {
  return `${channel === 'blog' ? `# ${content.title}\n\n` : ''}${content.body}${content.hashtags.length ? `\n\n${content.hashtags.join(' ')}` : ''}`;
}
export const agentEditSchema = agentContentSchema
  .extend({ version: z.number().int().positive() })
  .strict();
export const MAX_ACTIVE_AGENT_POSTS = 3;
export type AgentPost = AgentInput & {
  id: string;
  projectId: string;
  status: 'queued' | 'generating' | 'draft' | 'failed';
  content: AgentContent | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  model: string;
  error: { code: string; message: string } | null;
};
/** Private worker state, omitted from every API response. */
export type AgentPostJob = AgentPost & {
  createdBy: string;
  fingerprint: string;
  generation: number;
  attempts: number;
  retryRequestId?: string;
  context: {
    brand: Brand;
    brandbook?: Brandbook;
    language: string;
    country: string;
  };
  leaseOwner?: string;
  leaseExpiresAt?: string;
  paidCall?: { startedAt: string };
};
export type AgentPostPage = {
  items: AgentPost[];
  total: number;
  nextCursor: string | null;
  generationAvailable: boolean;
};
export function publicAgentPost(job: AgentPostJob): AgentPost {
  const {
    id,
    projectId,
    channel,
    topic,
    prompt,
    promptId,
    status,
    content,
    createdAt,
    updatedAt,
    version,
    model,
    error,
  } = job;
  return {
    id,
    projectId,
    channel,
    topic,
    prompt,
    ...(promptId ? { promptId } : {}),
    status,
    content,
    createdAt,
    updatedAt,
    version,
    model,
    error,
  };
}
