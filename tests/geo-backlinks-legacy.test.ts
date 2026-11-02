import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { newProject } from './fixtures/scanner.js';

it('imports explicit historical backlink types even when an unrelated action kind is present', async () => {
  const db = await localPostgres();
  try {
    const repository = new PostgresRepository(db), project = newProject({id:randomUUID()});
    await repository.saveProject(project,null);
    const accountId = (await db.query('SELECT account_id FROM citevia_projects WHERE id=$1',[project.id])).rows[0].account_id;
    for (const [type,action,domain] of [
      ['BACKLINK','editorial_update','publisher.com'],
      ['editorial','geo_backlink','anotherpublisher.com'],
      ['blog','editorial_update','ordinaryarticle.com'],
    ]) await db.query(`INSERT INTO recommendations(id,account_id,type,action_kind,target_url,effectiveness,insight,title,description,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'unknown','Saved historical evidence','Original recommendation','Recorded strategy','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z')`,
      [randomUUID(),accountId,type,action,`https://${domain}/article`]);
    const rows=await repository.listLegacyGeoBacklinkHistory(project.id);
    expect(rows.map(row=>row.url).sort()).toEqual(['https://anotherpublisher.com/article','https://publisher.com/article']);
    expect(rows.every(row=>row.recommendedAt==='2026-10-01T12:00:00.000Z')).toBe(true);
  } finally { await db.close(); }
},30000);
