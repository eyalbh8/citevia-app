-- Keep iGEO's users / user_accounts schema intact. Identity/access metadata lives here.
ALTER TABLE citevia_identities ADD COLUMN provider text NOT NULL DEFAULT 'legacy';
ALTER TABLE citevia_identities ADD COLUMN external_user_id text;
ALTER TABLE citevia_identities ADD COLUMN disabled boolean NOT NULL DEFAULT false;
ALTER TABLE citevia_identities ADD COLUMN access_version integer NOT NULL DEFAULT 1;
ALTER TABLE citevia_identities ADD COLUMN last_seen_at timestamptz;
CREATE UNIQUE INDEX citevia_identity_external_idx ON citevia_identities(provider, external_user_id) WHERE provider='descope';
CREATE UNIQUE INDEX citevia_users_email_lower_idx ON users(lower(email));
