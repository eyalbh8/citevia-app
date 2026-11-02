-- No account is opted in by migration. The switch lives in the account's optional JSON settings.
CREATE TABLE citevia_social_occurrences (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  slot_id text NOT NULL,
  local_date date NOT NULL,
  scheduled_at timestamptz NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id),
  UNIQUE (project_id,revision,slot_id,local_date),
  UNIQUE (project_id,sequence)
);
CREATE TABLE citevia_social_publications (
  project_id text NOT NULL,
  id text NOT NULL,
  occurrence_id text NOT NULL,
  destination_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','generating','review_required','publishing','published','draft_created','failed','cancelled','uncertain')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id),
  FOREIGN KEY (project_id,occurrence_id) REFERENCES citevia_social_occurrences(project_id,id) ON DELETE CASCADE,
  UNIQUE (project_id,occurrence_id,destination_id)
);
CREATE INDEX citevia_social_publications_history_idx ON citevia_social_publications(project_id,created_at DESC,id DESC);
CREATE INDEX citevia_social_publications_active_idx ON citevia_social_publications(updated_at,id)
  WHERE status IN ('queued','generating','publishing');
