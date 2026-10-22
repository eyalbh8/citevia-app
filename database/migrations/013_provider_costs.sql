-- Append-only attempt metadata. Native request and response evidence stays private in S3.
CREATE TABLE IF NOT EXISTS citevia_cost_events (
  call_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('reservation','outcome')),
  project_id text REFERENCES citevia_projects(id),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(call_id,phase)
);
CREATE INDEX IF NOT EXISTS citevia_cost_events_account_time
  ON citevia_cost_events(project_id,created_at) WHERE phase='reservation';
