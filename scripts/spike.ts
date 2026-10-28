import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileArtifacts, MemoryQueue, MemoryRepository } from '@citevia/storage';
import {
  promptTextSchema,
  scanProviderSchema,
  DEFAULT_PERPLEXITY_PRESET,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_ANALYSIS_MODEL,
} from '@citevia/core';
import { Scanner } from '../apps/scanner/src/engine.js';
import { createScanProviderFromEnv } from '../apps/scanner/src/providers.js';
import { createBootstrapProject } from './bootstrap.js';

async function main() {
  const argv = process.argv.slice(2),
    args = new Map<string, string>();
  if (argv.includes('--help')) {
    console.log(
      'Usage: npm run scan:spike -- --prompts ./prompts.txt --brand "Brand" --domain example.com [--provider openai|perplexity|gemini] [--count 10]\nMakes up to 10 paid collection calls on the selected provider and 10 analysis calls (Gemini by default). Requires credentials for both selected models. Saves evidence under .local-data/spike/. Review native citations, offsets, quality and cost before production.',
    );
    return;
  }
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !['--prompts', '--brand', '--domain', '--count', '--provider'].includes(
        argv[i],
      ) ||
      !argv[i + 1]
    )
      throw new Error('Invalid arguments. Use --help.');
    args.set(argv[i], argv[i + 1]);
  }
  if (!args.get('--prompts') || !args.get('--brand') || !args.get('--domain'))
    throw new Error('Supply --prompts, --brand and --domain; use --help.');
  const count = Number(args.get('--count') || '10');
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new Error('count must be 1–10');
  const prompts = (await readFile(resolve(args.get('--prompts')!), 'utf8'))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, count)
    .map((text) => promptTextSchema.parse(text));
  if (!prompts.length) throw new Error('No prompts provided');
  const selectedProvider = scanProviderSchema.parse(
    args.get('--provider') || 'openai',
  );
  const provider = createScanProviderFromEnv();
  const base = resolve(
    '.local-data',
    'spike',
    new Date().toISOString().replaceAll(':', '-'),
  );
  const repository = new MemoryRepository(),
    artifacts = new FileArtifacts(resolve(base, 'evidence')),
    queue = new MemoryQueue();
  const project = createBootstrapProject(
    {
      projectId: 'spike',
      name: 'Live validation',
      brand: args.get('--brand')!,
      domain: args.get('--domain')!,
      country: 'US',
      language: 'en',
      timezone: 'UTC',
      stack: '',
      email: '',
    },
    prompts,
    {
      generation: process.env.OPENAI_GENERATION_MODEL || 'gpt-4.1-2025-04-14',
      extraction:
        process.env.ANALYSIS_MODEL || process.env.OPENAI_EXTRACTION_MODEL || DEFAULT_ANALYSIS_MODEL,
    },
  );
  project.competitors = [];
  project.brand.aliases = [];
  project.scanProviders = [
    {
      provider: selectedProvider,
      model:
        selectedProvider === 'openai'
          ? project.generationModel
          : selectedProvider === 'perplexity'
            ? process.env.PERPLEXITY_PRESET || DEFAULT_PERPLEXITY_PRESET
            : process.env.GEMINI_GENERATION_MODEL || DEFAULT_GEMINI_MODEL,
    },
  ];
  await repository.saveProject(project, null);
  const scanner = new Scanner({ repository, artifacts, queue, provider });
  console.log(
    `Running ${prompts.length} live prompts on ${selectedProvider} (${project.scanProviders[0].model}); results will be saved locally.`,
  );
  await scanner.handle({
    kind: 'kickoff',
    projectId: project.id,
    scheduledAt: new Date().toISOString(),
    trigger: 'manual',
    requestId: 'initial-spike',
  });
  while (queue.messages.length) {
    const job = queue.messages.shift()!;
    try {
      await scanner.handle(job);
    } catch (error) {
      console.error(
        `Job failed: ${(error as Error).name}. Inspect saved evidence.`,
      );
    }
  }
  // Do not automatically repeat paid requests in the feasibility command.
  const run = (await repository.listRuns(project.id))[0],
    results = await repository.listResults(project.id, run.id);
  const report = {
    run,
    generationModel: run.snapshot.generationModel,
    provider: selectedProvider,
    extractionModel: project.extractionModel,
    results,
    reviewRequired: [
      'Verify all displayed source URLs against native annotations',
      'Review brand aliases and ambiguous names',
      'Check ranked vs unranked answers and no-mention cases',
      'Compare sentiment evidence against labels',
      'Record observed API cost and latency before deployment',
    ],
  };
  await mkdir(base, { recursive: true });
  await writeFile(
    resolve(base, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `${results.filter((r) => r.status === 'succeeded').length}/${results.length} analyzed. Review ${resolve(base, 'report.json')}`,
  );
  if (results.some((r) => r.status !== 'succeeded')) process.exitCode = 1;
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
