import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { AnswerProvider } from '@citevia/storage';
import type { Analysis, CapturedAnswer, ScanRun } from '@citevia/core';
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA,
  extractionInput,
  parseExtraction,
} from './extraction.js';
import { normalizeAnswer } from './normalize.js';
import {
  OpenAIProvider,
  ProviderError,
  type ProviderReceipt,
  type ResponseProvider,
} from './provider.js';
import {
  SCORED_PARSER_VERSION,
  parseScoredExtraction,
  scoredExtractionRequest,
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
    if (snapshot.parserVersion === SCORED_PARSER_VERSION) {
      const receipt = await this.provider.extract(
        scoredExtractionRequest(answer, snapshot),
      );
      try {
        return parseScoredExtraction(receipt, answer, snapshot);
      } catch (error) {
        if (error instanceof ProviderError)
          throw new ExtractionError(
            new ProviderError(
              error.code,
              error.message,
              false,
              error.requestId,
            ),
            receipt,
          );
        throw error;
      }
    }
    const receipt = await this.provider.extract({
      model: snapshot.extractionModel,
      instructions: EXTRACTION_INSTRUCTIONS,
      input: extractionInput(answer, snapshot),
      schema: EXTRACTION_SCHEMA,
    });
    try {
      return parseExtraction(receipt, answer, snapshot);
    } catch (error) {
      if (error instanceof ProviderError)
        throw new ExtractionError(error, receipt);
      throw error;
    }
  }
}

export async function createOpenAIProviderFromEnv(): Promise<AnswerProvider> {
  return new OpenAIAnswerProvider(await createResponseProviderFromEnv());
}
export async function createResponseProviderFromEnv(): Promise<ResponseProvider> {
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
  return new OpenAIProvider({ apiKey });
}
