import { z } from 'zod';
import type {
  Project,
  RunSnapshot,
  ScanProvider,
  ScanProviderConfig,
} from './types.js';

export const SCAN_PROVIDERS = ['openai', 'perplexity', 'gemini'] as const;
export const PROVIDER_LABELS: Record<ScanProvider, string> = {
  openai: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
};
export const DEFAULT_PERPLEXITY_PRESET = 'fast@2026-10-16.0';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_ANALYSIS_MODEL = 'gemini-3.8-flash';

/** Saved model IDs retain the analysis provider used by immutable run snapshots. */
export function analysisProvider(model: string): 'openai' | 'gemini' {
  return /^gemini-/.test(model) ? 'gemini' : 'openai';
}
export const scanProviderSchema = z.enum(SCAN_PROVIDERS);
export const scanProvidersSchema = z
  .array(
    z
      .object({
        provider: scanProviderSchema,
        model: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[A-Za-z0-9_.:@/-]+$/),
      })
      .strict(),
  )
  .min(1)
  .max(3)
  .refine(
    (items) =>
      new Set(items.map((item) => item.provider)).size === items.length,
    'Select each provider only once',
  );

/** Legacy accounts keep their existing paid workload until an owner saves provider settings. */
export function projectProviders(
  project: Pick<Project, 'scanProviders' | 'generationModel'>,
): ScanProviderConfig[] {
  return (
    project.scanProviders ?? [
      { provider: 'openai', model: project.generationModel },
    ]
  );
}
export function snapshotProvider(
  snapshot: Pick<RunSnapshot, 'provider'>,
): ScanProvider {
  return snapshot.provider ?? 'openai';
}
