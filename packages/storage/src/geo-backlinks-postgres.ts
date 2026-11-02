import { createHash } from 'node:crypto';
import type { GeoBacklinkActivity, GeoBacklinkCandidate, GeoBacklinkLedger, GeoBacklinkMonthlyReport, GeoBacklinkPerformanceSnapshot, GeoBacklinkRecommendation, Project } from '@citevia/core';
import { geoCanonicalDomain, geoSelectProposals, geoFinal, geoLedger, geoPageBounds, geoSameCohort, geoBestCandidates, geoRefreshCandidate, geoValidateCandidate, geoValidateRecommendation, type GeoBacklinkCommit, type GeoBacklinkPageOptions } from './geo-backlinks.js';
import type { SqlDatabase, SqlSession } from './sql.js';

const rowsData = <T>(rows: Record<string, unknown>[]) => rows.map(row => row.data as T);
const first = <T>(rows: Record<string, unknown>[]) => rows[0]?.data as T | undefined;
async function lockProject(db: SqlSession, projectId: string) {
  const project = first<Project>((await db.query('SELECT data FROM citevia_projects WHERE id=$1 FOR UPDATE', [projectId])).rows);
  if (!project) throw new Error('Project missing');
  return project;
}
async function writeReport(db: SqlSession, report: GeoBacklinkMonthlyReport) {
  await db.query('UPDATE citevia_geo_backlink_reports SET status=$3,version=$4,updated_at=$5,data=$6::jsonb WHERE project_id=$1 AND month=$2',
    [report.projectId, report.month, report.status, report.version, report.updatedAt, JSON.stringify(report)]);
}
async function insertRecommendation(db: SqlSession, item: GeoBacklinkRecommendation, actorId: string, at: string) {
  const inserted = await db.query(`INSERT INTO citevia_geo_backlink_recommendations(project_id,id,report_id,month,domain,recommended_at,status,version,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(project_id,id) DO NOTHING RETURNING id`,
    [item.projectId,item.id,item.reportId,item.month,item.domain,item.recommendedAt,item.status,item.version,JSON.stringify(item)]);
  if (!inserted.rows.length) return false;
  const previous = first<GeoBacklinkLedger>((await db.query('SELECT data FROM citevia_geo_backlink_ledger WHERE project_id=$1 AND domain=$2', [item.projectId,item.domain])).rows);
  const ledger = geoLedger(item, previous);
  await db.query(`INSERT INTO citevia_geo_backlink_ledger(project_id,domain,recommended_at,eligible_again_at,data) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(project_id,domain) DO UPDATE SET recommended_at=excluded.recommended_at,eligible_again_at=excluded.eligible_again_at,data=excluded.data`,
    [item.projectId,item.domain,ledger.lastRecommendedAt,ledger.eligibleAgainAt,JSON.stringify(ledger)]);
  await insertActivity(db, { id: `${item.id}:created`, projectId: item.projectId, recommendationId: item.id, actorId, at,
    action: item.imported ? 'imported' : 'recommended', fromStatus: null, toStatus: item.status, changes: {} });
  return true;
}
async function insertActivity(db: SqlSession, activity: GeoBacklinkActivity) {
  await db.query('INSERT INTO citevia_geo_backlink_activities(project_id,recommendation_id,id,created_at,data) VALUES($1,$2,$3,$4,$5::jsonb)',
    [activity.projectId,activity.recommendationId,activity.id,activity.at,JSON.stringify(activity)]);
}
export async function listGeoBacklinkProjects(db: SqlDatabase, offset: number, limit: number) {
  const where = "data->'geoBacklinks'->>'enabled'='true' AND NOT (data ? 'demo')";
  const bounds = geoPageBounds({offset,limit});
  const total = Number((await db.query(`SELECT count(*)::int AS total FROM citevia_projects WHERE ${where}`)).rows[0].total);
  return { items: rowsData<Project>((await db.query(`SELECT data FROM citevia_projects WHERE ${where} ORDER BY id LIMIT $1 OFFSET $2`, [bounds.limit,bounds.offset])).rows), total };
}
export async function reserveGeoBacklinkReport(db: SqlDatabase, report: GeoBacklinkMonthlyReport) {
  return db.transaction(async tx => {
    const project = await lockProject(tx, report.projectId);
    const existing = await getGeoBacklinkReport(tx,report.projectId,report.month);
    if (existing) return { status: 'existing' as const, report: existing };
    if (!project.geoBacklinks?.enabled || project.demo) throw new Error('GEO backlinks are disabled');
    if (report.version !== 1 || report.status !== 'queued' || report.selectedRecommendationIds.length) throw new Error('Invalid initial GEO report');
    await tx.query(`INSERT INTO citevia_geo_backlink_reports(project_id,month,id,status,version,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [report.projectId,report.month,report.id,report.status,report.version,report.createdAt,report.updatedAt,JSON.stringify(report)]);
    return { status: 'created' as const, report };
  });
}
export async function getGeoBacklinkReport(db: SqlSession, projectId: string, month: string) {
  return first<GeoBacklinkMonthlyReport>((await db.query('SELECT data FROM citevia_geo_backlink_reports WHERE project_id=$1 AND month=$2', [projectId,month])).rows) ?? null;
}
export async function claimGeoBacklinkReport(db: SqlDatabase, projectId: string, month: string, token: string, now: string, leaseUntil: string) {
  return db.transaction(async tx => {
    const project = await lockProject(tx,projectId);
    if (!project.geoBacklinks?.enabled || project.demo) return null;
    const current = await getGeoBacklinkReport(tx,projectId,month);
    if (!current || geoFinal(current) || (current.status === 'running' && Date.parse(current.leaseUntil || '') > Date.parse(now))) return null;
    if (!token || !(Date.parse(leaseUntil) > Date.parse(now))) throw new Error('Invalid GEO report lease');
    const report: GeoBacklinkMonthlyReport = { ...current, status: 'running', version: current.version+1, leaseToken: token, leaseUntil, updatedAt: now, error: undefined };
    await writeReport(tx,report); return report;
  });
}
export async function commitGeoBacklinkReport(db: SqlDatabase, input: GeoBacklinkCommit) {
  return db.transaction(async tx => {
    const project = await lockProject(tx,input.report.projectId);
    const current = await getGeoBacklinkReport(tx,input.report.projectId,input.report.month);
    if (!current || geoFinal(current)) return current;
    if (!project.geoBacklinks?.enabled || current.status !== 'running' || current.leaseToken !== input.leaseToken ||
      Date.parse(current.leaseUntil || '') <= Date.parse(input.now)) return null;
    if (!geoFinal(input.report) || input.report.id !== current.id) throw new Error('Invalid final GEO report');
    for (const candidate of geoBestCandidates(input.candidates)) {
      if (candidate.projectId !== project.id || candidate.evaluatedMonth !== current.month) throw new Error('Invalid GEO candidate account/month');
      geoValidateCandidate(candidate);
      const domain = geoCanonicalDomain(candidate.domain);
      const previous = first<GeoBacklinkCandidate>((await tx.query('SELECT data FROM citevia_geo_backlink_candidates WHERE project_id=$1 AND domain=$2', [project.id,domain])).rows);
      const next = geoRefreshCandidate({ ...candidate, domain }, previous);
      await tx.query(`INSERT INTO citevia_geo_backlink_candidates(project_id,domain,first_discovered_at,last_seen_at,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(project_id,domain) DO UPDATE SET first_discovered_at=excluded.first_discovered_at,last_seen_at=excluded.last_seen_at,data=excluded.data`,
        [project.id,domain,next.firstDiscoveredAt,next.lastSeenAt,JSON.stringify(next)]);
    }
    const ledger = rowsData<GeoBacklinkLedger>((await tx.query('SELECT data FROM citevia_geo_backlink_ledger WHERE project_id=$1', [project.id])).rows);
    const exclusionDays = Math.max(180,input.exclusionDays,current.settings.exclusionDays,project.geoBacklinks.exclusionDays);
    for (const proposed of input.recommendations) {
      if (proposed.projectId !== project.id || proposed.reportId !== current.id || proposed.month !== current.month || proposed.version !== 1 || !proposed.candidate || proposed.candidate.evaluatedMonth !== current.month)
        throw new Error('Invalid GEO recommendation cohort');
      geoValidateRecommendation(proposed);
    }
    const allocation = geoSelectProposals(input.recommendations,ledger,input.now,{...current.settings,exclusionDays});
    const selected: string[] = [];
    for (const proposed of allocation.selected) {
      const domain = geoCanonicalDomain(proposed.domain);
      const item = { ...proposed, domain, recommendedAt: input.now, eligibleAgainAt: new Date(Date.parse(input.now)+exclusionDays*86400000).toISOString() };
      if (await insertRecommendation(tx,item,input.report.requestedBy || 'system',input.now)) selected.push(item.id);
    }
    const report: GeoBacklinkMonthlyReport = { ...input.report, version: current.version+1, selectedRecommendationIds: selected,
      excludedCount: allocation.excludedCount, updatedAt: input.now, generatedAt: input.now };
    delete report.leaseToken; delete report.leaseUntil;
    await writeReport(tx,report); return report;
  });
}
export async function failGeoBacklinkReport(db: SqlDatabase, projectId: string, month: string, token: string, error: string, now: string) {
  return db.transaction(async tx => {
    await lockProject(tx,projectId);
    const current = await getGeoBacklinkReport(tx,projectId,month);
    if (!current || geoFinal(current) || current.leaseToken !== token) return false;
    const next: GeoBacklinkMonthlyReport = { ...current,status:'failed',version:current.version+1,updatedAt:now,error };
    delete next.leaseToken; delete next.leaseUntil;
    await writeReport(tx,next); return true;
  });
}
export async function listGeoBacklinkReports(db: SqlSession, projectId: string, offset: number, limit: number) {
  const bounds = geoPageBounds({offset,limit});
  const total = Number((await db.query('SELECT count(*)::int AS total FROM citevia_geo_backlink_reports WHERE project_id=$1',[projectId])).rows[0].total);
  return { items: rowsData<GeoBacklinkMonthlyReport>((await db.query('SELECT data FROM citevia_geo_backlink_reports WHERE project_id=$1 ORDER BY month DESC LIMIT $2 OFFSET $3',[projectId,bounds.limit,bounds.offset])).rows),total };
}
export async function listActiveGeoBacklinkReports(db: SqlSession, limit=100, now=new Date().toISOString()) {
  return rowsData<GeoBacklinkMonthlyReport>((await db.query(`SELECT report.data FROM citevia_geo_backlink_reports report JOIN citevia_projects project ON project.id=report.project_id
    WHERE project.data->'geoBacklinks'->>'enabled'='true' AND NOT(project.data ? 'demo')
    AND (report.status='queued' OR (report.status='failed' AND report.updated_at < $1::timestamptz-interval '5 minutes') OR
      (report.status='running' AND (report.data->>'leaseUntil')::timestamptz <= $1)) ORDER BY report.updated_at,report.project_id LIMIT $2`,[now,geoPageBounds({limit}).limit])).rows);
}
function filters(projectId: string, options: GeoBacklinkPageOptions, candidates=false) {
  const values: unknown[]=[projectId], where=['project_id=$1'];
  for (const [field,value] of [['month',options.month],['status',options.status],['priority',options.priority]] as const) if (value) {
    values.push(value); const column = field === 'month' && candidates ? 'evaluatedMonth' : field;
    where.push(`data->>'${column}'=$${values.length}`);
  }
  if (options.category) { values.push(options.category); where.push(`${candidates ? 'data' : "data->'candidate'"}->>'category'=$${values.length}`); }
  if (options.provider) { values.push(options.provider); where.push(`(${candidates ? 'data' : "data->'candidate'"}->'evidence'->'providers') ? $${values.length}`); }
  if (options.query) { values.push(`%${options.query.replace(/[\\%_]/g,'\\$&')}%`); where.push(`(domain ILIKE $${values.length} OR data->>'url' ILIKE $${values.length})`); }
  return {values,where:where.join(' AND ')};
}
export async function listGeoBacklinkCandidates(db: SqlSession, projectId: string, options: GeoBacklinkPageOptions={}) {
  const {values,where}=filters(projectId,options,true), bounds=geoPageBounds(options);
  const total=Number((await db.query(`SELECT count(*)::int AS total FROM citevia_geo_backlink_candidates WHERE ${where}`,values)).rows[0].total);
  return {items:rowsData<GeoBacklinkCandidate>((await db.query(`SELECT data FROM citevia_geo_backlink_candidates WHERE ${where} ORDER BY last_seen_at DESC,domain LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,bounds.limit,bounds.offset])).rows),total};
}
export async function listGeoBacklinkRecommendations(db: SqlSession, projectId: string, options: GeoBacklinkPageOptions={}) {
  const {values,where}=filters(projectId,options), bounds=geoPageBounds(options);
  const total=Number((await db.query(`SELECT count(*)::int AS total FROM citevia_geo_backlink_recommendations WHERE ${where}`,values)).rows[0].total);
  const sort={date:'recommended_at',recommendedAt:'recommended_at',domain:'domain',priority:"data->>'priority'",status:'status',score:"(data->'candidate'->>'score')::numeric",eligibleAgainAt:"(data->>'eligibleAgainAt')::timestamptz"}[options.sort || 'date'], direction=options.direction === 'asc' ? 'ASC' : 'DESC';
  return {items:rowsData<GeoBacklinkRecommendation>((await db.query(`SELECT data FROM citevia_geo_backlink_recommendations WHERE ${where} ORDER BY ${sort} ${direction},id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,bounds.limit,bounds.offset])).rows),total};
}
export async function getGeoBacklinkRecommendation(db: SqlSession, projectId: string, id: string) {
  return first<GeoBacklinkRecommendation>((await db.query('SELECT data FROM citevia_geo_backlink_recommendations WHERE project_id=$1 AND id=$2',[projectId,id])).rows) ?? null;
}
export async function saveGeoBacklinkRecommendation(db: SqlDatabase, next: GeoBacklinkRecommendation, expectedVersion: number, activity: GeoBacklinkActivity) {
  return db.transaction(async tx => {
    await lockProject(tx,next.projectId);
    const current=await getGeoBacklinkRecommendation(tx,next.projectId,next.id);
    if (!current || current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion+1 || !geoSameCohort(current,next) || activity.projectId !== next.projectId || activity.recommendationId !== next.id || activity.fromStatus !== current.status || activity.toStatus !== next.status) throw new Error('Invalid GEO recommendation update');
    await tx.query('UPDATE citevia_geo_backlink_recommendations SET status=$3,version=$4,data=$5::jsonb WHERE project_id=$1 AND id=$2',[next.projectId,next.id,next.status,next.version,JSON.stringify(next)]);
    await tx.query("UPDATE citevia_geo_backlink_ledger SET data=jsonb_set(data,'{status}',to_jsonb($3::text)) WHERE project_id=$1 AND domain=$2 AND data->>'recommendationId'=$4",[next.projectId,next.domain,next.status,next.id]);
    await insertActivity(tx,activity); return true;
  });
}
export async function listGeoBacklinkActivities(db: SqlSession, projectId: string, recommendationId: string, offset: number, limit: number) {
  const bounds=geoPageBounds({offset,limit});
  const total=Number((await db.query('SELECT count(*)::int AS total FROM citevia_geo_backlink_activities WHERE project_id=$1 AND recommendation_id=$2',[projectId,recommendationId])).rows[0].total);
  return { items:rowsData<GeoBacklinkActivity>((await db.query('SELECT data FROM citevia_geo_backlink_activities WHERE project_id=$1 AND recommendation_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[projectId,recommendationId,bounds.limit,bounds.offset])).rows),total };
}
export async function listGeoBacklinkLedger(db: SqlSession, projectId: string) {
  return rowsData<GeoBacklinkLedger>((await db.query('SELECT data FROM citevia_geo_backlink_ledger WHERE project_id=$1 ORDER BY domain',[projectId])).rows);
}
export async function importGeoBacklinkHistory(db: SqlDatabase, projectId: string, entries: GeoBacklinkRecommendation[], actorId: string, now: string) {
  return db.transaction(async tx => {
    await lockProject(tx,projectId); let inserted=0;
    for (const entry of entries) {
      if (entry.projectId !== projectId || entry.reportId !== null || entry.version !== 1 || !entry.imported || !Number.isFinite(Date.parse(entry.recommendedAt)) || Date.parse(entry.recommendedAt)>Date.parse(now)) throw new Error('Invalid historical GEO recommendation');
      geoValidateRecommendation(entry);
      const item={...entry,domain:geoCanonicalDomain(entry.domain),eligibleAgainAt:new Date(Math.max(Date.parse(entry.eligibleAgainAt)||0,Date.parse(entry.recommendedAt)+180*86400000)).toISOString()};
      if (await insertRecommendation(tx,item,actorId,now)) inserted++;
    }
    return inserted;
  });
}
export async function listLegacyGeoBacklinkHistory(db: SqlSession, projectId: string) {
  const rows=(await db.query(`SELECT recommendation.id,recommendation.target_url,recommendation.created_at FROM recommendations recommendation
    JOIN citevia_projects project ON project.account_id=recommendation.account_id WHERE project.id=$1
    AND (lower(recommendation.action_kind) IN ('backlink','geo_backlink','backlink_placement','link_building')
      OR lower(recommendation.type) IN ('backlink','geo_backlink','backlink_placement','link_building'))
    AND recommendation.target_url ~ '^https?://' ORDER BY recommendation.created_at,recommendation.id`,[projectId])).rows;
  return rows.map(row=>({id:String(row.id),url:String(row.target_url),recommendedAt:new Date(row.created_at as string).toISOString(),source:'legacy:recommendations'}));
}
export async function putGeoBacklinkPerformance(db: SqlDatabase, snapshot: GeoBacklinkPerformanceSnapshot) {
  return db.transaction(async tx => {
    await lockProject(tx,snapshot.projectId);
    const recommendation=await getGeoBacklinkRecommendation(tx,snapshot.projectId,snapshot.recommendationId);
    if (!recommendation || recommendation.publishedAt !== snapshot.publicationDate || (recommendation.publishedUrl || recommendation.url) !== snapshot.publicationUrl) return false;
    return Boolean((await tx.query(`INSERT INTO citevia_geo_backlink_performance(project_id,recommendation_id,checkpoint,publication_date,publication_url,publication_url_hash,measured_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(project_id,recommendation_id,publication_date,publication_url_hash,checkpoint) DO UPDATE SET measured_at=excluded.measured_at,data=excluded.data
      WHERE citevia_geo_backlink_performance.data->>'status'='insufficient_data' RETURNING recommendation_id`,
      [snapshot.projectId,snapshot.recommendationId,snapshot.checkpoint,snapshot.publicationDate,snapshot.publicationUrl,createHash('sha256').update(snapshot.publicationUrl).digest('hex'),snapshot.measuredAt,JSON.stringify(snapshot)])).rows.length);
  });
}
export async function listGeoBacklinkPerformance(db: SqlSession, projectId: string, recommendationId?: string) {
  return rowsData<GeoBacklinkPerformanceSnapshot>((await db.query(`SELECT data FROM citevia_geo_backlink_performance WHERE project_id=$1${recommendationId ? ' AND recommendation_id=$2':''} ORDER BY publication_date DESC,checkpoint`,recommendationId?[projectId,recommendationId]:[projectId])).rows);
}
