CREATE TABLE citevia_agent_posts (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','generating','draft','failed')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id)
);
CREATE INDEX citevia_agent_posts_history_idx ON citevia_agent_posts(project_id,created_at DESC,id DESC);
CREATE INDEX citevia_agent_posts_active_idx ON citevia_agent_posts(status) WHERE status IN ('queued','generating');
