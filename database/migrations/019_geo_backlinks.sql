-- Monthly backlink cohorts are immutable; campaign progress lives on recommendations.
-- All admission, finalization and historical imports serialize on the project row.
CREATE TABLE citevia_geo_backlink_reports (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','insufficient_data','failed')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,month),
  UNIQUE (project_id,id)
);
CREATE INDEX citevia_geo_backlink_report_jobs_idx ON citevia_geo_backlink_reports(updated_at,project_id,month)
  WHERE status IN ('queued','running','failed');
CREATE TABLE citevia_geo_backlink_candidates (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  first_discovered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,domain)
);
CREATE INDEX citevia_geo_backlink_candidate_history_idx ON citevia_geo_backlink_candidates(project_id,last_seen_at DESC,domain);
CREATE TABLE citevia_geo_backlink_recommendations (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  report_id text,
  month text NOT NULL,
  domain text NOT NULL,
  recommended_at timestamptz NOT NULL,
  status text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id),
  FOREIGN KEY (project_id,report_id) REFERENCES citevia_geo_backlink_reports(project_id,id),
  UNIQUE (project_id,report_id,domain)
);
CREATE INDEX citevia_geo_backlink_recommendation_history_idx ON citevia_geo_backlink_recommendations(project_id,recommended_at DESC,id DESC);
CREATE INDEX citevia_geo_backlink_recommendation_status_idx ON citevia_geo_backlink_recommendations(project_id,status,recommended_at DESC);
-- A per-domain exclusion summary backed by immutable dated recommendation history.
CREATE TABLE citevia_geo_backlink_ledger (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  recommended_at timestamptz NOT NULL,
  eligible_again_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,domain)
);
CREATE INDEX citevia_geo_backlink_domain_exclusion_idx ON citevia_geo_backlink_ledger(project_id,domain,recommended_at DESC);
CREATE TABLE citevia_geo_backlink_activities (
  project_id text NOT NULL,
  recommendation_id text NOT NULL,
  id text NOT NULL,
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id),
  FOREIGN KEY (project_id,recommendation_id) REFERENCES citevia_geo_backlink_recommendations(project_id,id) ON DELETE CASCADE
);
CREATE INDEX citevia_geo_backlink_activity_history_idx ON citevia_geo_backlink_activities(project_id,recommendation_id,created_at DESC,id DESC);
CREATE TABLE citevia_geo_backlink_performance (
  project_id text NOT NULL,
  recommendation_id text NOT NULL,
  checkpoint integer NOT NULL CHECK (checkpoint IN (0,30,60,90)),
  publication_date timestamptz NOT NULL,
  publication_url text NOT NULL,
  publication_url_hash text NOT NULL,
  measured_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,recommendation_id,publication_date,publication_url_hash,checkpoint),
  FOREIGN KEY (project_id,recommendation_id) REFERENCES citevia_geo_backlink_recommendations(project_id,id) ON DELETE CASCADE
);
CREATE INDEX citevia_geo_backlink_performance_history_idx ON citevia_geo_backlink_performance(project_id,measured_at DESC);
