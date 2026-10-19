-- Workflow state supplements the unchanged iGEO tables; it never replaces their reporting rows.
CREATE TABLE citevia_projects (
  id text PRIMARY KEY, account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  version integer NOT NULL, data jsonb NOT NULL
);
CREATE TABLE citevia_identities (
  subject text PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id)
);
CREATE TABLE citevia_runs (
  project_id text NOT NULL REFERENCES citevia_projects(id), id text NOT NULL,
  scan_id uuid NOT NULL UNIQUE REFERENCES scans(id), status text NOT NULL,
  scheduled_at timestamptz NOT NULL, result_version integer NOT NULL,
  terminal_count integer NOT NULL, total_count integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE INDEX citevia_runs_active_idx ON citevia_runs(status) WHERE status IN ('queued','running');
CREATE INDEX citevia_runs_project_date_idx ON citevia_runs(project_id,scheduled_at DESC);
CREATE TABLE citevia_prompt_results (
  project_id text NOT NULL, run_id text NOT NULL, prompt_id text NOT NULL,
  version integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(project_id,run_id,prompt_id),
  FOREIGN KEY(project_id,run_id) REFERENCES citevia_runs(project_id,id)
);
CREATE TABLE citevia_onboarding_jobs (
  project_id text NOT NULL REFERENCES citevia_projects(id), id text NOT NULL,
  owner_id text NOT NULL, status text NOT NULL, version integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(project_id,id), UNIQUE(owner_id,id)
);
CREATE INDEX citevia_onboarding_active_idx ON citevia_onboarding_jobs(status) WHERE status IN ('queued','running');
