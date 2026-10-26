import type { WebsiteHealthJob } from '@citevia/core';
import type { SqlDatabase } from './sql.js';

export async function getWebsiteHealthAudit(db: SqlDatabase, projectId: string, auditId: string): Promise<WebsiteHealthJob | null> {
  const { rows } = await db.query('SELECT data FROM citevia_website_health_audits WHERE project_id=$1 AND id=$2', [projectId, auditId]);
  return rows[0]?.data as WebsiteHealthJob || null;
}

export async function listWebsiteHealthAudits(db: SqlDatabase, projectId: string, offset: number, limit: number) {
  const total = Number((await db.query('SELECT count(*)::int AS total FROM citevia_website_health_audits WHERE project_id=$1', [projectId])).rows[0].total);
  // History needs scores and timestamps only; large issue/resource lists stay in detail reads.
  let summary = "data #- '{results,mobile,field}' #- '{results,desktop,field}'";
  for (const device of ['mobile', 'desktop']) for (const field of ['metrics', 'issues', 'warnings'])
    summary = `jsonb_set(${summary}, '{results,${device},lab,${field}}', '[]'::jsonb)`;
  const { rows } = await db.query(`SELECT ${summary} AS data FROM citevia_website_health_audits WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [projectId, limit, offset]);
  return { items: rows.map(row => row.data as WebsiteHealthJob), total };
}

export async function listActiveWebsiteHealthAudits(db: SqlDatabase) {
  return (await db.query("SELECT data FROM citevia_website_health_audits WHERE status IN ('queued','running')")).rows.map(row => row.data as WebsiteHealthJob);
}

export async function saveWebsiteHealthAudit(db: SqlDatabase, job: WebsiteHealthJob, expectedVersion: number) {
  if (job.version !== expectedVersion + 1) throw new Error('Invalid website health audit version');
  return Boolean((await db.query(
    'UPDATE citevia_website_health_audits SET status=$3,version=$4,data=$5::jsonb WHERE project_id=$1 AND id=$2 AND version=$6 RETURNING id',
    [job.projectId, job.id, job.status, job.version, JSON.stringify(job), expectedVersion],
  )).rows.length);
}

export async function reserveWebsiteHealthAudit(db: SqlDatabase, job: WebsiteHealthJob, _expectedVersion: null): Promise<'saved' | 'conflict' | 'limit'> {
  if (job.version !== 1) throw new Error('Invalid website health reservation version');
  return db.transaction(async tx => {
    // Lock the account, including its first admission, so concurrent requests share the cap and cooldown.
    if (!(await tx.query('SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE', [job.projectId])).rows.length)
      throw new Error('Project missing');
    if ((await tx.query('SELECT id FROM citevia_website_health_audits WHERE project_id=$1 AND id=$2', [job.projectId, job.id])).rows.length)
      return 'conflict';
    const recent = await tx.query(
      "SELECT id FROM citevia_website_health_audits WHERE project_id=$1 AND (status IN ('queued','running') OR created_at > $2::timestamptz - interval '60 seconds') LIMIT 1",
      [job.projectId, job.createdAt],
    );
    if (recent.rows.length) return 'limit';
    await tx.query('INSERT INTO citevia_website_health_audits(project_id,id,status,version,created_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [job.projectId, job.id, job.status, job.version, job.createdAt, JSON.stringify(job)]);
    return 'saved';
  });
}
