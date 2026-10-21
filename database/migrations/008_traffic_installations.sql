-- Installation receipts are independent of AI referrals and brandbook domains.
CREATE TABLE citevia_traffic_installations (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  origin text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  tracker_version text NOT NULL,
  PRIMARY KEY (project_id, origin)
);
CREATE INDEX citevia_traffic_installations_last_seen_idx ON citevia_traffic_installations(project_id, last_seen_at DESC);
