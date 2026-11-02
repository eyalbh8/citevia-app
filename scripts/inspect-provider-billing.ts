import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { externalDatabaseConfig } from '../packages/storage/src/database-config.js';

// Read-only proof of the billing envelope. Never print artifact keys, receipt bodies,
// account identifiers, prompts, credentials or provider IDs.
const { values } = parseArgs({ options: { 'secret-arn': { type: 'string' }, bucket: { type: 'string' } } });
let client: Client | undefined;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
try {
  if (!values['secret-arn'] || !values.bucket) throw new Error('Provide source secret and evidence bucket.');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: values['secret-arn'] }));
  client = new Client({ ...externalDatabaseConfig(secret.SecretString || ''), query_timeout: 20000, application_name: 'citevia-billing-envelope-inspection' });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '20s'");
  const { rows } = await client.query("SELECT s3_key FROM prompt_responses WHERE provider='perplexity' AND s3_key IS NOT NULL ORDER BY timestamp DESC LIMIT 3");
  await client.query('ROLLBACK');
  const s3 = new S3Client({ maxAttempts: 2 });
  const metadata = [];
  for (const row of rows) {
    if (typeof row.s3_key !== 'string' || !row.s3_key.startsWith('projects/')) continue;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: values.bucket, Key: row.s3_key }), { abortSignal: controller.signal });
      if (!result.Body || (result.ContentLength ?? 0) > 8 * 1024 * 1024) { controller.abort(); throw new Error('Receipt exceeds inspection bound.'); }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > 8 * 1024 * 1024) { controller.abort(); throw new Error('Receipt exceeds inspection bound.'); }
        chunks.push(chunk);
      }
      const capture = record(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      const native = record(record(capture.raw).response), usage = record(native.usage), cost = record(usage.cost);
      const amount = typeof cost.total_cost === 'number' ? cost.total_cost :
        typeof cost.total_cost === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cost.total_cost) ? Number(cost.total_cost) : NaN;
      metadata.push({ nativeReceiptPresent: Object.keys(native).length > 0,
        inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens),
        costObjectPresent: Object.keys(cost).length > 0, currencyIsUsd: cost.currency === 'USD',
        totalCostFieldType: typeof cost.total_cost, totalCostValidNonnegative: Number.isFinite(amount) && amount >= 0,
        costKeys: Object.keys(cost).filter(key => ['currency', 'total_cost', 'input_tokens_cost', 'output_tokens_cost', 'request_cost', 'tool_cost'].includes(key)).sort(),
      });
    } finally { clearTimeout(timer); }
  }
  console.log(JSON.stringify({ readOnly: true, provider: 'perplexity', inspected: metadata.length, metadata }, null, 2));
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(JSON.stringify({ event: 'billing_envelope_inspection_failed', code: code && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'inspection_error' }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
