import { analysisProvider, snapshotProvider, type ScanProvider } from '@citevia/core';
import type { AnswerProvider, ProviderAdmissionPolicy, ProviderAdmissionStore } from '@citevia/storage';
import { ProviderError } from './provider.js';

function setting(provider: string, name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[`SCANNER_${provider.toUpperCase()}_${name}`] ?? process.env[`SCANNER_PROVIDER_${name}`] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`SCANNER_${provider.toUpperCase()}_${name} is outside its supported range.`);
  return value;
}
export function providerAdmissionPolicy(provider: ScanProvider): ProviderAdmissionPolicy {
  return {
    minIntervalMs: setting(provider, 'MIN_INTERVAL_MS', 10_000, 1_000, 3600_000),
    maxConcurrent: setting(provider, 'MAX_CONCURRENT', 2, 1, 20),
    // A crashed worker releases capacity after all supported HTTP deadlines have elapsed.
    leaseMs: 300_000,
  };
}

/** Cache is composed outside this wrapper; cost reservations and HTTP calls are inside it. */
export function guardScanProvider(provider: AnswerProvider, store: ProviderAdmissionStore,
  options: { policy?: (provider: ScanProvider) => ProviderAdmissionPolicy } = {}): AnswerProvider {
  async function run<T>(scope: ScanProvider, call: () => Promise<T>, quotaDependency?: string): Promise<T> {
    const policy = (options.policy ?? providerAdmissionPolicy)(scope);
    let decision;
    try { decision = await store.acquire(scope, policy, quotaDependency); }
    catch {
      // Fail closed: a database outage must not turn into an uncontrolled provider burst.
      throw new ProviderError('provider_admission_unavailable', 'Provider scheduling is temporarily unavailable.', true, null,
        { kind: 'deferred', safeToRetry: true, provider: scope, retryAfterMs: 30_000 });
    }
    if (!decision.admitted) {
      if (decision.reason === 'quota')
        throw new ProviderError('provider_quota_blocked', 'Provider usage is paused until its billing or quota issue is resolved.', false, null,
          { kind: 'quota', safeToRetry: false, provider: decision.blockedScope });
      throw new ProviderError('provider_admission_deferred', 'Waiting for shared provider capacity.', true, null,
        { kind: 'deferred', safeToRetry: true, provider: scope, retryAfterMs: decision.retryAfterMs });
    }
    let failure: { kind: 'rate_limit' | 'quota'; retryAfterMs?: number } | undefined;
    try { return await call(); }
    catch (error) {
      if (error instanceof ProviderError && (error.kind === 'rate_limit' || error.kind === 'quota'))
        failure = { kind: error.kind, retryAfterMs: error.retryAfterMs };
      else if (error instanceof ProviderError && error.kind === 'transient' && error.retryAfterMs !== undefined)
        failure = { kind: 'rate_limit', retryAfterMs: error.retryAfterMs };
      throw error;
    } finally {
      // Retrying this idempotent metadata write never buys another provider call.
      // A brief database interruption should not lose a shared quota/cooldown signal.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await store.complete(scope, decision.leaseId, failure);
          break;
        } catch {
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
            continue;
          }
          // Never discard a paid successful response because releasing its lease failed.
          // The crash lease expires and subsequent admissions still require the database.
          console.error(JSON.stringify({ event: 'provider_admission_release_failed', provider: scope }));
        }
      }
    }
  }
  return {
    collect: (prompt, snapshot) => run(snapshotProvider(snapshot), () => provider.collect(prompt, snapshot), analysisProvider(snapshot.extractionModel)),
    extract: (answer, snapshot) => run(analysisProvider(snapshot.extractionModel), () => provider.extract(answer, snapshot)),
  };
}
