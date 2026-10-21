-- Original captures are the unit of identity, including across reanalysis runs.
CREATE TABLE citevia_citation_captures (
  project_id text NOT NULL REFERENCES citevia_projects(id), capture_key text NOT NULL,
  run_id text NOT NULL, captured_at timestamptz NOT NULL,
  analyzed boolean NOT NULL, analysis_at timestamptz NOT NULL, result_version integer NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(project_id,capture_key),
  FOREIGN KEY(project_id,run_id) REFERENCES citevia_runs(project_id,id)
);
CREATE INDEX citevia_captures_period_idx ON citevia_citation_captures(project_id,captured_at);
CREATE TABLE citevia_response_citations (
  project_id text NOT NULL, capture_key text NOT NULL, normalized_url text NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(project_id,capture_key,normalized_url),
  FOREIGN KEY(project_id,capture_key) REFERENCES citevia_citation_captures(project_id,capture_key) ON DELETE CASCADE
);
CREATE INDEX citevia_citations_url_idx ON citevia_response_citations(project_id,normalized_url);
CREATE TABLE citevia_tracked_urls (
  project_id text NOT NULL REFERENCES citevia_projects(id), id uuid NOT NULL REFERENCES tracked_recommendations(id),
  normalized_url text NOT NULL, active boolean NOT NULL, created_at timestamptz NOT NULL,
  version integer NOT NULL, normalization_version integer NOT NULL DEFAULT 1, data jsonb NOT NULL,
  PRIMARY KEY(project_id,id), UNIQUE(project_id,normalized_url)
);
CREATE TABLE citevia_tracked_url_matches (
  project_id text NOT NULL, tracked_url_id uuid NOT NULL, capture_key text NOT NULL, normalized_url text NOT NULL,
  PRIMARY KEY(project_id,tracked_url_id,capture_key),
  FOREIGN KEY(project_id,tracked_url_id) REFERENCES citevia_tracked_urls(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,capture_key,normalized_url) REFERENCES citevia_response_citations(project_id,capture_key,normalized_url) ON DELETE CASCADE
);
CREATE INDEX citevia_matches_capture_idx ON citevia_tracked_url_matches(project_id,capture_key);
