-- A photo may be selected only once per account and channel, including failed attempts.
CREATE TABLE citevia_agent_images (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  channel text NOT NULL,
  photo_id text NOT NULL,
  post_id text NOT NULL,
  generation integer NOT NULL,
  image jsonb NOT NULL,
  PRIMARY KEY (project_id, channel, photo_id),
  UNIQUE (project_id, channel, post_id, generation)
);
-- Preserve all historical photo usage; older duplicates have one canonical reservation.
INSERT INTO citevia_agent_images(project_id,channel,photo_id,post_id,generation,image)
SELECT project_id,data->>'channel',data->'content'->'image'->>'photoId',id,
       COALESCE((data->>'generation')::int,1),data->'content'->'image'
FROM citevia_agent_posts
WHERE data->'content'->'image'->>'photoId' IS NOT NULL
ORDER BY created_at,id
ON CONFLICT DO NOTHING;
