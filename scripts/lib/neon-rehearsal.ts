import type { SqlDatabase, SqlSession } from '../../packages/storage/src/sql.js';
import { PostgresRepository } from '../../packages/storage/src/postgres.js';
import { identifier, MigrationSafetyError, type MigrationInventory } from './postgres-migration.js';

/** Hash only the original columns after additive migrations; preserve original ledger rows. */
export async function originalTableFingerprints(db: SqlSession, original: MigrationInventory) {
  const fingerprints: MigrationInventory['tables'] = [];
  for (const table of original.tables) {
    const columns = original.schema.columns.filter(column => column.table_name === table.name)
      .sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position));
    if (!columns.length) throw new MigrationSafetyError('An original table has no inventoried columns');
    const ledger = table.name === 'citevia_migrations';
    const buckets = (await db.query(`WITH hashed AS (
      SELECT encode(sha256(convert_to(to_jsonb(original_row)::text,'UTF8')),'hex') AS h
      FROM (SELECT ${columns.map(column => identifier(String(column.column_name))).join(',')}
        FROM public.${identifier(table.name)}${ledger ? ' WHERE name=ANY($1::text[])' : ''}) original_row
    ) SELECT substring(h from 1 for 2) AS bucket,count(*)::text AS count,
      encode(sha256(convert_to(string_agg(h,'' ORDER BY h COLLATE "C"),'UTF8')),'hex') AS hash
      FROM hashed GROUP BY substring(h from 1 for 2) ORDER BY bucket`,
    ledger ? [original.migrations.map(migration => migration.name)] : undefined)).rows;
    fingerprints.push({ name: table.name, count: buckets.reduce((sum, row) => sum + BigInt(String(row.count)), 0n).toString(), buckets });
  }
  return fingerprints;
}

/** All returned values are counts, fixed public probes, or fingerprints; no customer text. */
export async function localeChecks(db: SqlSession) {
  const environment = (await db.query(`SELECT datlocprovider,datcollate,datctype,datcollversion,
    coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale') AS provider_locale
    FROM pg_database d WHERE datname=current_database()`)).rows[0];
  const email = (await db.query(`SELECT count(*)::int AS users,
    count(*) FILTER (WHERE octet_length(email)<>length(email))::int AS non_ascii_emails,
    (count(*)-count(DISTINCT lower(email)))::int AS lower_collisions,
    encode(sha256(convert_to(coalesce(string_agg(id::text||':'||encode(sha256(convert_to(lower(email),'UTF8')),'hex'),
      E'\\n' ORDER BY id),''),'UTF8')),'hex') AS canonical_digest FROM users`)).rows[0];
  const fields = (await db.query(`WITH fields(kind,id,value) AS (
    SELECT 'email',id::text,email FROM users UNION ALL
    SELECT 'name',id::text,coalesce(name,'') FROM users UNION ALL
    SELECT 'account_title',id::text,title FROM accounts UNION ALL
    SELECT 'domain',a.id::text||':'||d.ordinality::text,d.domain FROM accounts a
      CROSS JOIN LATERAL unnest(a.domains) WITH ORDINALITY d(domain,ordinality)
  ), mapped AS (SELECT kind,id,octet_length(value)<>length(value) AS non_ascii,
    encode(sha256(convert_to(jsonb_build_array(lower(value),upper(value),
      value ILIKE '%i%',value ILIKE '%é%',value ILIKE '%σ%',value ILIKE '%İ%',value ~ '[[:alpha:]]')::text,'UTF8')),'hex') AS h
    FROM fields)
    SELECT kind,count(*)::int AS items,count(*) FILTER (WHERE non_ascii)::int AS non_ascii_items,
      encode(sha256(convert_to(string_agg(id||':'||h,E'\\n' ORDER BY id COLLATE "C"),'UTF8')),'hex') AS behavior_digest
    FROM mapped GROUP BY kind ORDER BY kind COLLATE "C"`)).rows;
  const probes = (await db.query(`WITH p(label,s) AS (VALUES ('ascii','AbC'),('accent',U&'\\00C9'),
    ('dotted_i',U&'\\0130'),('dotless_i',U&'\\0131'),('sigma',U&'\\03A3'),('capital_sharp_s',U&'\\1E9E'),('hebrew',U&'\\05D0'))
    SELECT label,encode(convert_to(lower(s),'UTF8'),'hex') AS lower_hex,
      encode(convert_to(upper(s),'UTF8'),'hex') AS upper_hex,s ~ '^[[:alpha:]]+$' AS is_alpha,
      s ILIKE lower(s) AS ilike_lower FROM p ORDER BY label COLLATE "C"`)).rows;
  const ordering = (await db.query(`SELECT array_agg(s ORDER BY s) AS default_order,
    array_agg(s ORDER BY s COLLATE "C") AS byte_order
    FROM (VALUES ('a'),('A'),('ä'),('Z'),('a-b'),('ab'),('a_b')) p(s)`)).rows[0];
  const traffic = (await db.query(`WITH x AS (SELECT id,
    lower(substring(referrer from '^https?://([^/:?#]+)')) AS host,
    CASE WHEN upper(country) ~ '^[A-Z]{2}$' THEN upper(country) ELSE 'ZZ' END AS country_code FROM analytics_events)
    SELECT count(*)::int AS events,encode(sha256(convert_to(coalesce(string_agg(jsonb_build_array(id,host,country_code)::text,
      E'\\n' ORDER BY id),''),'UTF8')),'hex') AS attribution_digest FROM x`)).rows[0];
  return { environment, email, fields, probes, ordering, traffic };
}

export function compareLocaleChecks(source: Awaited<ReturnType<typeof localeChecks>>, target: Awaited<ReturnType<typeof localeChecks>>) {
  const criticalDifferences = (['email','fields','traffic'] as const).filter(name => JSON.stringify(source[name]) !== JSON.stringify(target[name]));
  if (Number(target.email.lower_collisions)) criticalDifferences.push('email');
  return { compatibleExistingData: criticalDifferences.length === 0, criticalDifferences: [...new Set(criticalDifferences)],
    probeDifferences: JSON.stringify(source.probes) !== JSON.stringify(target.probes),
    defaultOrderingChanged: JSON.stringify(source.ordering.default_order) !== JSON.stringify(target.ordering.default_order),
    stableByteOrdering: JSON.stringify(source.ordering.byte_order) === JSON.stringify(target.ordering.byte_order) };
}

export async function assertTypedBackfills(db: SqlSession) {
  const run = (await db.query(`SELECT count(*)::int AS mismatches FROM citevia_runs WHERE
    succeeded_count IS DISTINCT FROM coalesce((data->>'succeededCount')::int,0) OR
    captured_count IS DISTINCT FROM coalesce((data->>'capturedCount')::int,0) OR
    started_at IS DISTINCT FROM (data->>'startedAt')::timestamptz OR
    completed_at IS DISTINCT FROM (data->>'completedAt')::timestamptz OR
    deadline_at IS DISTINCT FROM (data->>'deadlineAt')::timestamptz OR
    summary_key IS DISTINCT FROM data->>'summaryKey' OR
    summary_version IS DISTINCT FROM (data->>'summaryVersion')::int`)).rows[0];
  const result = (await db.query(`SELECT count(*)::int AS mismatches FROM citevia_prompt_results p
    JOIN citevia_runs r ON r.project_id=p.project_id AND r.id=p.run_id
    WHERE p.observed_at IS DISTINCT FROM coalesce(p.data->>'capturedAt',r.data->>'createdAt')::timestamptz`)).rows[0];
  if (Number(run.mismatches) || Number(result.mismatches)) throw new MigrationSafetyError('Typed migration backfill invariants failed');
  return { runMismatches: Number(run.mismatches), observationMismatches: Number(result.mismatches) };
}

export async function repositoryReadSmoke(db: SqlDatabase) {
  const repository = new PostgresRepository(db, { compactRunState: false, writeCompatibilityResults: true });
  const projects = (await db.query('SELECT id FROM citevia_projects ORDER BY id LIMIT 5')).rows;
  let runs = 0, results = 0, answerPages = 0;
  for (const item of projects) {
    const projectId = String(item.id);
    if (!(await repository.getProject(projectId))) throw new MigrationSafetyError('Repository project read failed');
    for (const run of await repository.listRuns(projectId, 5)) {
      if (!(await repository.getRun(projectId, run.id))) throw new MigrationSafetyError('Repository run read failed');
      const answers = await repository.listResults(projectId, run.id);
      runs++; results += answers.length;
      if (answers[0]) {
        const page = await repository.listPromptAnswerPage(projectId, { promptId: answers[0].promptId,
          start: '1970-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z', sort: 'date', direction: 'desc', offset: 0, limit: 25 });
        if (page) answerPages++;
      }
    }
  }
  let users = 0;
  for (const row of (await db.query("SELECT subject FROM citevia_identities WHERE provider='descope' LIMIT 5")).rows) {
    if (!(await repository.getUser(String(row.subject)))) throw new MigrationSafetyError('Repository user read failed');
    users++;
  }
  return { projects: projects.length, runs, results, answerPages, users };
}

/** Caller MUST wrap this in an outer transaction and roll it back. Repository uses savepoints. */
export async function repositoryWriteCanary(db: SqlDatabase) {
  const first = (await db.query('SELECT project_id,run_id,prompt_id FROM citevia_prompt_results ORDER BY project_id,run_id,prompt_id LIMIT 1')).rows[0];
  if (!first) return { skipped: true, reason: 'No prompt results available', writes: 0 };
  let writes = 0;
  for (const compactRunState of [true, false]) {
    const repository = new PostgresRepository(db, { compactRunState, writeCompatibilityResults: true });
    const projectId = String(first.project_id), runId = String(first.run_id), promptId = String(first.prompt_id);
    const previous = await repository.getResult(projectId, runId, promptId);
    const before = await repository.getRun(projectId, runId);
    if (!previous || !before) throw new MigrationSafetyError('Canary cannot load an existing result/run');
    const next = { ...previous, version: previous.version + 1 };
    if (!(await repository.commitResult(next, previous)) || await repository.commitResult(next, previous))
      throw new MigrationSafetyError('Repository canary compare-and-swap failed');
    const after = await repository.getRun(projectId, runId);
    if (!after || after.resultVersion !== before.resultVersion + 1 || after.terminalCount !== before.terminalCount ||
      after.succeededCount !== before.succeededCount || after.capturedCount !== before.capturedCount)
      throw new MigrationSafetyError('Repository canary counters changed unexpectedly');
    if (!compactRunState) {
      const stored = (await db.query('SELECT data FROM citevia_runs WHERE project_id=$1 AND id=$2', [projectId, runId])).rows[0].data;
      if (JSON.stringify(stored) !== JSON.stringify(after)) {
        // JSONB key order and JS insertion order differ; compare within PostgreSQL.
        if (!(await db.query('SELECT $1::jsonb=$2::jsonb AS equal', [JSON.stringify(stored), JSON.stringify(after)])).rows[0].equal)
          throw new MigrationSafetyError('Dual-write canary JSON diverged from typed state');
      }
    }
    writes++;
  }
  return { skipped: false, writes };
}
