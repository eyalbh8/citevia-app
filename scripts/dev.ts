import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  FileArtifacts,
  PostgresRepository,
  MemoryQueue,
} from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { createApi } from '../apps/api/src/app.js';
import { Scanner } from '../apps/scanner/src/engine.js';
import {
  createOpenAIProviderFromEnv,
  createResponseProviderFromEnv,
} from '../apps/scanner/src/openai.js';
import { OnboardingEngine } from '../apps/scanner/src/onboarding-engine.js';
import { OpenAIOnboardingProvider } from '../apps/scanner/src/onboarding-provider.js';
import { assertRealLocalData } from './local-data.js';

if (
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('The local development server must not run in production');
process.env.APP_MODE = 'local';
const configured = Boolean(
  process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_SECRET_ARN?.trim(),
);
const base = resolve(process.env.LOCAL_DATA_DIR || '.local-data/real');
let api: ReturnType<typeof createApi> | undefined;
const server = createServer(async (req, res) => {
  try {
    if (!api) {
      res.writeHead(503);
      res.end('Citevia is starting');
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 160000) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
    });
    const method = req.method || 'GET';
    const path = (req.url || '/').replace(/^\/api(?=\/)/, '');
    const request = new Request(`http://127.0.0.1:3001${path}`, {
      method,
      headers,
      ...(!['GET', 'HEAD'].includes(method) && chunks.length
        ? { body: Buffer.concat(chunks).toString('utf8') }
        : {}),
    });
    const result = await api(request);
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(await result.text());
  } catch (error) {
    console.error('Local API error:', (error as Error).message);
    res.writeHead(500);
    res.end('Request failed');
  }
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(3001, '127.0.0.1', done);
});
// Bind before opening the database: a second process must not touch shared data.
const db = await localPostgres(resolve(base, 'postgres')),
  repository = new PostgresRepository(db),
  artifacts = new FileArtifacts(resolve(base, 'artifacts')),
  queue = new MemoryQueue();
await assertRealLocalData(db);
const runtime = { repository, artifacts, queue };
let scanner: Scanner | undefined;
if (configured) {
  const provider = await createOpenAIProviderFromEnv();
  const onboarding = new OnboardingEngine(
    runtime,
    new OpenAIOnboardingProvider(await createResponseProviderFromEnv()),
    async () => {},
  );
  scanner = new Scanner({ ...runtime, provider, onboarding });
}
api = createApi(runtime, {
  auth: 'local',
  mode: 'live',
  providerConfigured: configured,
});
// Start empty. Never seed sample accounts or automatically import legacy stores.
let processing = false;
const worker = setInterval(async () => {
  if (processing || !scanner || !queue.messages.length) return;
  processing = true;
  const message = queue.messages.shift()!;
  try {
    await scanner.handle(message);
  } catch (error) {
    console.error('Scan job will be recovered:', (error as Error).message);
  } finally {
    processing = false;
  }
}, 100);
const recovery = setInterval(
  () =>
    scanner
      ?.handle({ kind: 'reconcile' })
      .catch((error) =>
        console.error('Recovery failed:', (error as Error).message),
      ),
  60_000,
);
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--strictPort',
  ],
  {
    cwd: resolve('apps/client'),
    env: { ...process.env, VITE_AUTH_MODE: 'local', VITE_API_URL: '/api/v1' },
    stdio: 'inherit',
  },
);
console.log(
  `API ready at http://127.0.0.1:3001 · ${configured ? 'Real OpenAI calls are enabled' : 'OpenAI is not configured; generation and scans are disabled'} · Data: ${base}`,
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(worker);
  clearInterval(recovery);
  vite.kill('SIGTERM');
  server.close();
  void db.close().finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', stop);
