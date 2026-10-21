CREATE TABLE citevia_mcp_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES citevia_identities(subject) ON DELETE CASCADE,
  -- Removing an account deletes its credentials; SET NULL would grant global access.
  project_id text REFERENCES citevia_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api_key','oauth')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX citevia_mcp_connections_owner_idx ON citevia_mcp_connections(user_id,project_id,created_at DESC);

CREATE TABLE citevia_mcp_records (
  kind text NOT NULL CHECK (kind IN ('client','code','refresh','access','consent')),
  id text NOT NULL,
  data jsonb NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY(kind,id)
);
CREATE INDEX citevia_mcp_records_expiry_idx ON citevia_mcp_records(expires_at) WHERE expires_at IS NOT NULL;

-- Only the latest window is retained per bucket; a delayed older request cannot reset it.
CREATE TABLE citevia_mcp_request_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count>0)
);
