-- Account-independent admission protects the API credentials shared by Lambda workers.
-- No prompts, answers, credentials or provider error bodies are stored here.
CREATE TABLE IF NOT EXISTS citevia_provider_admission (
  scope text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT '-infinity',
  cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
  quota_blocked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS citevia_provider_leases (
  id text PRIMARY KEY,
  scope text NOT NULL REFERENCES citevia_provider_admission(scope) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS citevia_provider_leases_scope_expiry
  ON citevia_provider_leases(scope, expires_at);
