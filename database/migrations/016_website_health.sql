CREATE TABLE citevia_website_health_audits (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','partial','failed')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id)
);
CREATE INDEX citevia_website_health_history_idx ON citevia_website_health_audits(project_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX citevia_website_health_active_idx ON citevia_website_health_audits(project_id) WHERE status IN ('queued','running');
