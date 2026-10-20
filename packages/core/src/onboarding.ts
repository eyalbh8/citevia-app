import { z } from 'zod';
import { getDomain } from 'tldts';
import type { JourneyStage, OnboardingInput } from './types.js';
export const JOURNEY_STAGES = [
  'understand',
  'prefer',
  'trust',
  'convert',
] as const;
export const journeyStageSchema = z.enum(JOURNEY_STAGES);
export const JOURNEY_PROMPT_COUNTS = {
  understand: 13,
  prefer: 13,
  trust: 12,
  convert: 12,
} as const;
export function journeyGoal(stage: JourneyStage, name: string): string {
  return {
    understand: `Does AI understand what ${name} does?`,
    prefer: `Does AI prefer ${name} over rivals?`,
    trust: `Does AI trust ${name} as a source?`,
    convert: `Does AI help buyers take the next step?`,
  }[stage];
}
export const promptFingerprint = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const textList = z.array(z.string().trim().min(1).max(1000)).max(30);
const publicUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !!getDomain(url.hostname) &&
      !/\.(example|invalid|test|local)$/i.test(url.hostname)
    );
  }, 'Use a public website URL, without credentials or a custom port');
export const onboardingInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    website: publicUrl,
    region: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  })
  .strict();
export const generatedBrandbookSchema = z
  .object({
    about: z.string().trim().min(20).max(10000),
    industryCategory: z.string().max(300),
    subIndustryCategory: z.string().max(300),
    names: z.array(z.string().trim().min(1).max(120)).max(20),
    keyFeatures: textList,
    toneOfVoice: textList,
    values: textList,
    personality: textList,
    targetAudience: textList,
    knowledgeSources: z.array(publicUrl).max(30),
    sitemapUrl: publicUrl.nullable(),
    caseStudiesSourceUrl: publicUrl.nullable(),
    postGuidelines: z.object({ dos: textList, donts: textList }).strict(),
    evidence: z
      .array(
        z
          .object({
            field: z.string().max(100),
            quote: z.string().min(1).max(2000),
            url: publicUrl,
          })
          .strict(),
      )
      .max(50),
    unknowns: textList,
  })
  .strict();
export const brandbookUpdateSchema = generatedBrandbookSchema.extend({
  version: z.number().int().positive(),
});
export const generatedPromptSchema = z
  .object({
    text: z.string().trim().min(5).max(2000),
    stage: journeyStageSchema,
    topic: z.string().trim().min(1).max(200),
    branded: z.boolean(),
  })
  .strict();
export function journeyAllocation(
  manual: OnboardingInput['manualPrompts'],
): Record<JourneyStage, number> {
  const counts = Object.fromEntries(
    JOURNEY_STAGES.map((stage) => [
      stage,
      manual.filter((prompt) => prompt.stage === stage).length,
    ]),
  ) as Record<JourneyStage, number>;
  const add = { understand: 0, prefer: 0, trust: 0, convert: 0 };
  for (let i = manual.length; i < 50; i++) {
    const stage = [...JOURNEY_STAGES].sort((a, b) => counts[a] - counts[b])[0];
    counts[stage]++;
    add[stage]++;
  }
  return add;
}
