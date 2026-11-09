import {
  ACTIVE_SOCIAL_PUBLICATION_STATUSES,
  socialOccurrenceLocalDate,
  type Project,
  type ReserveSocialOccurrenceInput,
  type ReserveSocialOccurrenceResult,
  type SocialOccurrence,
  type SocialPublication,
} from '@citevia/core';
import type { SqlDatabase, SqlSession } from './sql.js';
import type { SocialReviewLink } from './contracts.js';
import { createSocialRecords, socialOccurrenceId, socialPageBounds, socialSlotKey } from './social-records.js';

export async function reserveSocialOccurrence(db: SqlDatabase, input: ReserveSocialOccurrenceInput): Promise<ReserveSocialOccurrenceResult> {
  return db.transaction(async tx => {
    // The same account lock used by settings writes makes enabled/revision checks and rotation atomic.
    const project = (await tx.query('SELECT data FROM citevia_projects WHERE id=$1 FOR UPDATE', [input.projectId])).rows[0]?.data as Project | undefined;
    const localDate = project && socialOccurrenceLocalDate(project, input, input.now);
    if (!project || !localDate) return { status: 'stale' };
    const occurrenceId = socialOccurrenceId(input, localDate);
    const existing = (await tx.query('SELECT data FROM citevia_social_occurrences WHERE project_id=$1 AND id=$2', [input.projectId, occurrenceId])).rows[0]?.data as SocialOccurrence | undefined;
    if (existing) {
      const publications = (await tx.query('SELECT data FROM citevia_social_publications WHERE project_id=$1 AND occurrence_id=$2 ORDER BY id', [input.projectId, occurrenceId])).rows.map(row => row.data as SocialPublication);
      return { status: 'existing', occurrence: existing, publications };
    }
    const previous = (await tx.query('SELECT data FROM citevia_social_occurrences WHERE project_id=$1 ORDER BY sequence DESC LIMIT 1', [input.projectId])).rows[0]?.data as SocialOccurrence | undefined;
    const records = createSocialRecords(project, input, localDate, previous ?? null);
    if (!records) return { status: 'empty' };
    const { occurrence, publications } = records;
    await tx.query(`INSERT INTO citevia_social_occurrences(project_id,id,revision,slot_id,local_date,scheduled_at,sequence,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [occurrence.projectId, occurrence.id, occurrence.revision,
      socialSlotKey(occurrence), occurrence.localDate, occurrence.scheduledAt, occurrence.sequence, JSON.stringify(occurrence)]);
    for (const publication of publications) await tx.query(`INSERT INTO citevia_social_publications(project_id,id,occurrence_id,destination_id,status,version,created_at,updated_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [publication.projectId, publication.id, publication.occurrenceId,
      publication.destination.id, publication.status, publication.version, publication.createdAt, publication.updatedAt, JSON.stringify(publication)]);
    return { status: 'created', occurrence, publications };
  });
}
export async function getSocialPublication(db: SqlDatabase, projectId: string, publicationId: string): Promise<SocialPublication | null> {
  return ((await db.query('SELECT data FROM citevia_social_publications WHERE project_id=$1 AND id=$2', [projectId, publicationId])).rows[0]?.data as SocialPublication) ?? null;
}
export async function listActiveSocialPublications(db: SqlDatabase, limit = 100, now = new Date().toISOString()): Promise<SocialPublication[]> {
  return (await db.query(`SELECT data FROM citevia_social_publications WHERE status=ANY($1::text[])
    AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz <= $3::timestamptz)
    ORDER BY updated_at,id LIMIT $2`,
    [ACTIVE_SOCIAL_PUBLICATION_STATUSES, socialPageBounds(0, limit).limit, now])).rows.map(row => row.data as SocialPublication);
}
export async function listSocialPublications(db: SqlDatabase, projectId: string, offset: number, limit: number, clientReviewOnly = false): Promise<{ items: SocialPublication[]; total: number }> {
  const bounds = socialPageBounds(offset, limit);
  const scope = clientReviewOnly
    ? "project_id=$1 AND status='review_required' AND data->'destination'->>'channel' IN ('facebook','instagram')"
    : 'project_id=$1';
  const total = Number((await db.query(`SELECT count(*)::int AS total FROM citevia_social_publications WHERE ${scope}`, [projectId])).rows[0].total);
  const items = (await db.query(`SELECT data FROM citevia_social_publications WHERE ${scope} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
    [projectId, bounds.limit, bounds.offset])).rows.map(row => row.data as SocialPublication);
  return { items, total };
}
export async function getSocialReviewPosts(db: SqlDatabase, projectId: string, ids: string[]) {
  const { rows } = await db.query('SELECT data FROM citevia_social_publications WHERE project_id=$1 AND id=ANY($2::text[])', [projectId, ids]);
  return rows.map(row => row.data as SocialPublication);
}
export async function createSocialReviewLink(db: SqlDatabase, link: SocialReviewLink) {
  await db.query('INSERT INTO citevia_social_review_links(project_id,id,created_at,expires_at,data) VALUES($1,$2,$3,$4,$5::jsonb)',
    [link.projectId, link.id, link.createdAt, link.expiresAt, JSON.stringify(link)]);
}
export async function getSocialReviewLink(db: SqlDatabase, projectId: string, id: string, now: string) {
  const { rows } = await db.query('SELECT data FROM citevia_social_review_links WHERE project_id=$1 AND id=$2 AND expires_at>$3', [projectId, id, now]);
  return rows[0]?.data as SocialReviewLink ?? null;
}
export async function listSocialReviewLinks(db: SqlDatabase, projectId: string, now: string) {
  const { rows } = await db.query('SELECT data FROM citevia_social_review_links WHERE project_id=$1 AND expires_at>$2 ORDER BY created_at DESC,id', [projectId, now]);
  return rows.map(row => row.data as SocialReviewLink);
}
export async function revokeSocialReviewLink(db: SqlDatabase, projectId: string, id: string) {
  const { rows } = await db.query('DELETE FROM citevia_social_review_links WHERE project_id=$1 AND id=$2 RETURNING id', [projectId, id]);
  return rows.length > 0;
}
export async function saveSocialPublication(db: SqlDatabase, publication: SocialPublication, expectedVersion: number, reviewLinkId?: string): Promise<boolean> {
  if (!reviewLinkId) return writeSocialPublication(db, publication, expectedVersion);
  return db.transaction(async tx => {
    // Serialize revocation with approval, including during an upstream account lookup.
    const link = await tx.query('SELECT id FROM citevia_social_review_links WHERE project_id=$1 AND id=$2 AND expires_at>$3 FOR SHARE',
      [publication.projectId, reviewLinkId, publication.updatedAt]);
    return link.rows.length > 0 && writeSocialPublication(tx, publication, expectedVersion);
  });
}
async function writeSocialPublication(db: SqlSession, publication: SocialPublication, expectedVersion: number) {
  if (publication.version !== expectedVersion + 1) throw new Error('Invalid social publication version');
  return Boolean((await db.query(`UPDATE citevia_social_publications SET status=$3,version=$4,updated_at=$5,data=$6::jsonb
    WHERE project_id=$1 AND id=$2 AND version=$7 AND occurrence_id=$8 AND destination_id=$9 RETURNING id`,
  [publication.projectId, publication.id, publication.status, publication.version, publication.updatedAt,
    JSON.stringify(publication), expectedVersion, publication.occurrenceId, publication.destination.id])).rows.length);
}
