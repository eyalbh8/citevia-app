import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createAwsRuntime, PostgresCallLedger, productionDatabase, type AnswerProvider, type CallLedger } from '@citevia/storage';
import type { Analysis, CapturedAnswer, ScanRun } from '@citevia/core';
import { analysisRequest, parseAnalysisReceipt } from './analysis-request.js';
import { normalizeAnswer } from './normalize.js';
import { observeResponseProvider } from './cost-observer.js';
import {
  OpenAIProvider,
  ProviderError,
  type ProviderReceipt,
  type ResponseProvider,
} from './provider.js';
import {
  SCORED_PARSER_VERSION,
} from './scoring-extraction.js';

/** Extraction errors retain their native response for private diagnostic evidence storage. */
export class ExtractionError extends ProviderError {
  constructor(
    error: ProviderError,
    public readonly receipt: ProviderReceipt,
  ) {
    super(error.code, error.message, error.retryable, error.requestId);
  }
}

export class OpenAIAnswerProvider implements AnswerProvider {
  constructor(private readonly provider: ResponseProvider) {}
  async collect(
    prompt: string,
    snapshot: ScanRun['snapshot'],
  ): Promise<CapturedAnswer> {
    const receipt = await this.provider.answer({
      costContext: { projectId: snapshot.projectId, ...snapshot.execution, stage: 'collection' },
      prompt,
      model: snapshot.generationModel,
      country: snapshot.country,
      language: snapshot.language,
      timezone: snapshot.timezone,
    });
    return normalizeAnswer(receipt, snapshot.generationModel);
  }
  async extract(
    answer: CapturedAnswer,
    snapshot: ScanRun['snapshot'],
  ): Promise<Analysis> {
    const receipt = await this.provider.extract(analysisRequest(answer, snapshot));
    try {
      return parseAnalysisReceipt(receipt, answer, snapshot);
    } catch (error) {
      // A validation failure proves this paid call returned a response. Network,
      // timeout and submission uncertainty never purchase a hidden replacement.
      if (error instanceof ProviderError && error.code === 'invalid_extraction' &&
          snapshot.extractionFallbackModel && snapshot.extractionFallbackModel !== snapshot.extractionModel) {
        const fallbackSnapshot = { ...snapshot, extractionModel:snapshot.extractionFallbackModel, extractionFallbackModel:undefined };
        let fallback: ProviderReceipt;
        try { fallback = await this.provider.extract(analysisRequest(answer,fallbackSnapshot)); }
        catch (failure) {
          const rejected = failure instanceof ProviderError ? failure : new ProviderError(
            'analysis_fallback_failed','The analyzer fallback could not be completed. Retry explicitly after review.',false,
          );
          throw new ExtractionError(
            // The primary call is already paid. An uncertain fallback must not replay both calls.
            new ProviderError(rejected.code,rejected.message,false,rejected.requestId),
            { ...receipt, fallbackRequestFailure:{code:rejected.code,requestId:rejected.requestId} } as ProviderReceipt,
          );
        }
        try {
          const analysis = parseAnalysisReceipt(fallback,answer,fallbackSnapshot);
          return { ...analysis,
            validationWarnings:[...(analysis.validationWarnings || []),`Analyzer fallback from ${snapshot.extractionModel}`],
            raw:{...fallback,rejectedPrimaryReceipt:receipt},
          };
        } catch (failure) {
          if (failure instanceof ProviderError) throw new ExtractionError(
            new ProviderError(failure.code,failure.message,false,failure.requestId),
            {...fallback,rejectedPrimaryReceipt:receipt} as ProviderReceipt,
          );
          throw failure;
        }
      }
      if (error instanceof ProviderError)
        throw new ExtractionError(
          snapshot.parserVersion === SCORED_PARSER_VERSION
            ? new ProviderError(error.code, error.message, false, error.requestId)
            : error,
          receipt,
        );
      throw error;
    }
  }
}

export async function createOpenAIProviderFromEnv(ledger?: CallLedger): Promise<AnswerProvider> {
  return new OpenAIAnswerProvider(await createResponseProviderFromEnv(ledger));
}
export async function createResponseProviderFromEnv(ledger?: CallLedger | null): Promise<ResponseProvider> {
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && process.env.OPENAI_SECRET_ARN) {
    const secret = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.OPENAI_SECRET_ARN }),
    );
    if (secret.SecretString) {
      try {
        const json: unknown = JSON.parse(secret.SecretString);
        apiKey =
          typeof json === 'object' &&
          json !== null &&
          'OPENAI_API_KEY' in json &&
          typeof json.OPENAI_API_KEY === 'string'
            ? json.OPENAI_API_KEY
            : undefined;
      } catch {
        apiKey = secret.SecretString;
      }
    }
  }
  if (!apiKey)
    throw new Error(
      'Configure OPENAI_SECRET_ARN (secret value or {"OPENAI_API_KEY":"..."}) or OPENAI_API_KEY for local development.',
    );
  const provider = new OpenAIProvider({ apiKey });
  // Explicit null isolates local evaluation from the application's production cost ledger.
  const costs = ledger === null ? undefined : ledger ?? (process.env.APP_MODE === 'aws' ? new PostgresCallLedger(productionDatabase(),createAwsRuntime().artifacts) : undefined);
  return costs ? observeResponseProvider(provider, costs) : provider;
}
