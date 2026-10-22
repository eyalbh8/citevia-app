import {
  MAX_ACTIVE_AGENT_POSTS,
  type AgentImage,
  type AgentPostJob,
} from '@citevia/core';
import type { SqlDatabase } from './sql.js';

export async function getAgentPost(
  db: SqlDatabase,
  projectId: string,
  postId: string,
): Promise<AgentPostJob | null> {
  return (
    ((
      await db.query(
        'SELECT data FROM citevia_agent_posts WHERE project_id=$1 AND id=$2',
        [projectId, postId],
      )
    ).rows[0]?.data as AgentPostJob) ?? null
  );
}
export async function listAgentPosts(
  db: SqlDatabase,
  projectId: string,
  offset: number,
  limit: number,
) {
  const total = Number(
    (
      await db.query(
        'SELECT count(*)::int AS total FROM citevia_agent_posts WHERE project_id=$1',
        [projectId],
      )
    ).rows[0].total,
  );
  const { rows } = await db.query(
    'SELECT data FROM citevia_agent_posts WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
    [projectId, limit, offset],
  );
  return { items: rows.map((row) => row.data as AgentPostJob), total };
}
export async function listActiveAgentPosts(db: SqlDatabase) {
  return (
    await db.query(
      "SELECT data FROM citevia_agent_posts WHERE status IN ('queued','generating')",
    )
  ).rows.map((row) => row.data as AgentPostJob);
}
export async function saveAgentPost(
  db: SqlDatabase,
  post: AgentPostJob,
  expectedVersion: number,
) {
  if (post.version !== expectedVersion + 1)
    throw new Error('Invalid agent post version');
  return Boolean(
    (
      await db.query(
        'UPDATE citevia_agent_posts SET status=$3,version=$4,data=$5::jsonb WHERE project_id=$1 AND id=$2 AND version=$6 RETURNING id',
        [
          post.projectId,
          post.id,
          post.status,
          post.version,
          JSON.stringify(post),
          expectedVersion,
        ],
      )
    ).rows.length,
  );
}
export async function reserveAgentPost(
  db: SqlDatabase,
  post: AgentPostJob,
  expectedVersion: number | null,
): Promise<'saved' | 'conflict' | 'limit'> {
  if (post.version !== (expectedVersion ?? 0) + 1)
    throw new Error('Invalid agent reservation version');
  return db.transaction(async (tx) => {
    // Serialize admission per account; simultaneous requests cannot bypass its cap.
    if (
      !(
        await tx.query(
          'SELECT id FROM citevia_projects WHERE id=$1 FOR UPDATE',
          [post.projectId],
        )
      ).rows.length
    )
      throw new Error('Project missing');
    const existing = (
      await tx.query(
        'SELECT version FROM citevia_agent_posts WHERE project_id=$1 AND id=$2',
        [post.projectId, post.id],
      )
    ).rows[0];
    if (
      expectedVersion === null
        ? Boolean(existing)
        : existing?.version !== expectedVersion
    )
      return 'conflict';
    const active = Number(
      (
        await tx.query(
          "SELECT count(*)::int AS count FROM citevia_agent_posts WHERE project_id=$1 AND id<>$2 AND status IN ('queued','generating')",
          [post.projectId, post.id],
        )
      ).rows[0].count,
    );
    if (active >= MAX_ACTIVE_AGENT_POSTS) return 'limit';
    if (expectedVersion === null)
      await tx.query(
        'INSERT INTO citevia_agent_posts(project_id,id,status,version,created_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          post.projectId,
          post.id,
          post.status,
          post.version,
          post.createdAt,
          JSON.stringify(post),
        ],
      );
    else {
      // Workers also use CAS, so a state change during admission cannot be overwritten.
      const saved = await tx.query(
        'UPDATE citevia_agent_posts SET status=$3,version=$4,data=$5::jsonb WHERE project_id=$1 AND id=$2 AND version=$6 RETURNING id',
        [
          post.projectId,
          post.id,
          post.status,
          post.version,
          JSON.stringify(post),
          expectedVersion,
        ],
      );
      if (!saved.rows.length) return 'conflict';
    }
    return 'saved';
  });
}

export async function reserveAgentImage(
  db: SqlDatabase,
  post: AgentPostJob,
  image?: AgentImage,
): Promise<AgentImage | null> {
  if (image)
    await db.query(
      `INSERT INTO citevia_agent_images(project_id,channel,photo_id,post_id,generation,image)
     SELECT $1,$2,$3,$4,$5,$6::jsonb FROM citevia_agent_posts
     WHERE project_id=$1 AND id=$4 AND data->>'channel'=$2 AND (data->>'generation')::int=$5
     AND NOT EXISTS (SELECT 1 FROM citevia_agent_posts historical
       WHERE historical.project_id=$1 AND historical.data->>'channel'=$2
       AND historical.data->'content'->'image'->>'photoId'=$3
       AND NOT (historical.id=$4 AND (historical.data->>'generation')::int=$5))
     ON CONFLICT DO NOTHING`,
      [
        post.projectId,
        post.channel,
        image.photoId,
        post.id,
        post.generation,
        JSON.stringify(image),
      ],
    );
  const { rows } = await db.query(
    'SELECT image FROM citevia_agent_images WHERE project_id=$1 AND channel=$2 AND post_id=$3 AND generation=$4',
    [post.projectId, post.channel, post.id, post.generation],
  );
  return (rows[0]?.image as AgentImage) || null;
}
