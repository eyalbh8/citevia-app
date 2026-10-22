import { parseArgs } from 'node:util';
import { productionDatabase, SqlProviderAdmissionStore } from '@citevia/storage';

const { values } = parseArgs({ options: {
  provider: { type: 'string' },
  'reset-quota': { type: 'boolean', default: false },
  'billing-resolved': { type: 'boolean', default: false },
  help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Usage: npm run scanner:providers -- [--provider openai|gemini|perplexity] [--reset-quota --billing-resolved]\nReads shared provider scheduling state. Reset requires an explicit provider and confirmation that credits/limits have been fixed. Uses the configured production database; never changes provider billing or starts a scan.');
} else {
  if (values.provider && !['openai', 'gemini', 'perplexity'].includes(values.provider))
    throw new Error('Choose openai, gemini or perplexity.');
  if (values['reset-quota'] && (!values.provider || !values['billing-resolved']))
    throw new Error('Quota reset requires --provider and --billing-resolved after fixing the provider account.');
  const db = productionDatabase();
  try {
    if (values['reset-quota']) await new SqlProviderAdmissionStore(db).resetQuota(values.provider!);
    const { rows } = await db.query(`SELECT a.scope,a.next_request_at,a.cooldown_until,a.quota_blocked_at,
      (SELECT count(*)::int FROM citevia_provider_leases l WHERE l.scope=a.scope AND l.expires_at>clock_timestamp()) AS active_requests
      FROM citevia_provider_admission a WHERE ($1::text IS NULL OR a.scope=$1) ORDER BY a.scope`, [values.provider ?? null]);
    console.log(JSON.stringify({ providers: rows, quotaReset: values['reset-quota'] }, null, 2));
  } finally { await db.close(); }
}
