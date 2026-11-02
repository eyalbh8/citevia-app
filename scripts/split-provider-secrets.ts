import { parseArgs } from 'node:util';
import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// Values stay in process memory and Secrets Manager. Never write credentials to
// local files, command arguments, stdout, exception text or the repository.
const targets = [
  ['OpenAiSecretArn', 'OPENAI_API_KEY', 'openai'],
  ['PerplexitySecretArn', 'PERPLEXITY_API_KEY', 'perplexity'],
  ['GeminiSecretArn', 'GEMINI_API_KEY', 'gemini'],
  ['GooglePageSpeedSecretArn', 'GOOGLE_PAGESPEED_API_KEY', 'pagespeed'],
  ['GoogleCruxSecretArn', 'GOOGLE_CRUX_API_KEY', 'crux'],
  ['ZernioSecretArn', 'ZERNIO_API_KEY', 'zernio'],
] as const;
const { values } = parseArgs({ options: { 'source-arn': { type: 'string' }, apply: { type: 'boolean' } } });
if (!values['source-arn']?.match(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+$/))
  throw new Error('Supply --source-arn with the existing combined provider secret ARN.');
const sourceArn = values['source-arn'];
const client = new SecretsManagerClient({ region: sourceArn.split(':')[3] });
try {
  if (!values.apply) {
    await client.send(new DescribeSecretCommand({ SecretId: sourceArn }));
    console.log(JSON.stringify({ apply: false, sourceArn,
      targets: targets.map(([parameter, field, name]) => ({ parameter, field, name: `citevia/providers/${name}-v1` })),
      behavior: 'Copy one credential field per secret in memory; refuse to overwrite a different existing value; retain source for rollback.' }, null, 2));
  } else {
    const source = await client.send(new GetSecretValueCommand({ SecretId: sourceArn }));
    let data: Record<string, unknown>;
    try { data = JSON.parse(source.SecretString || ''); }
    catch { throw new Error('Source is not a JSON object'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
      targets.some(([, field]) => typeof data[field] !== 'string' || !(data[field] as string).trim()))
      throw new Error('Source does not contain every required provider field; no secrets created');
    const result: Record<string, string> = {};
    for (const [parameter, field, name] of targets) {
      const secretName = `citevia/providers/${name}-v1`;
      const value = JSON.stringify({ [field]: data[field] });
      try {
        const existing = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
        if (existing.SecretString !== value) throw new Error('Existing destination differs; refusing to overwrite');
        result[parameter] = existing.ARN!;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
        const created = await client.send(new CreateSecretCommand({ Name: secretName, SecretString: value,
          Description: `Citevia ${name} credential; isolated from other providers`,
          Tags: [{ Key: 'Application', Value: 'Citevia' }, { Key: 'Purpose', Value: 'provider' }] }));
        result[parameter] = created.ARN!;
      }
    }
    console.log(JSON.stringify({ apply: true, parameters: result, sourceRetained: true }, null, 2));
  }
} catch (error) {
  // SDK/PostgreSQL errors may include request details; print only a safe category.
  console.error(JSON.stringify({ event: 'provider_secret_split_failed', category: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally { client.destroy(); }
