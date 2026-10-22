-- Only orchestration references live in PostgreSQL; request/response payloads stay in private S3.
CREATE TABLE IF NOT EXISTS citevia_analysis_batches (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  status text NOT NULL CHECK (status IN ('prepared','creating','submission_uncertain','submitted','resolved','processed')),
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS citevia_analysis_batches_open_run
  ON citevia_analysis_batches(project_id,run_id) WHERE status <> 'processed';
CREATE INDEX IF NOT EXISTS citevia_analysis_batches_expiration ON citevia_analysis_batches(expires_at);
