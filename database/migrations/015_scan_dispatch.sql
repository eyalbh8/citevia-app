-- The durable work backlog stays in Postgres. SQS receives only a bounded set of
-- reservations; a lost send or worker is recovered by its expiring lease.
CREATE TABLE citevia_dispatch_state (
  id integer PRIMARY KEY CHECK (id=1),
  sequence bigint NOT NULL DEFAULT 0
);
INSERT INTO citevia_dispatch_state(id) VALUES(1);

CREATE TABLE citevia_dispatch_accounts (
  project_id text PRIMARY KEY REFERENCES citevia_projects(id) ON DELETE CASCADE,
  last_turn bigint NOT NULL DEFAULT 0
);

CREATE TABLE citevia_dispatch_jobs (
  project_id text NOT NULL,
  run_id text NOT NULL,
  prompt_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','gemini','perplexity')),
  ready_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','leased','running')),
  token text,
  lease_until timestamptz,
  PRIMARY KEY(project_id,run_id,prompt_id),
  FOREIGN KEY(project_id,run_id,prompt_id)
    REFERENCES citevia_prompt_results(project_id,run_id,prompt_id) ON DELETE CASCADE,
  CHECK ((state='ready' AND token IS NULL AND lease_until IS NULL)
    OR (state IN ('leased','running') AND token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX citevia_dispatch_jobs_ready
  ON citevia_dispatch_jobs(project_id,ready_at,created_at) WHERE state='ready';
CREATE INDEX citevia_dispatch_jobs_outstanding
  ON citevia_dispatch_jobs(provider,project_id,lease_until) WHERE state IN ('leased','running');
