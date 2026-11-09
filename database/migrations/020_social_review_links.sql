-- An owner delegates review of a bounded list of exact destination revisions.
-- The primary key contains the SHA-256 digest, never the bearer credential.
CREATE TABLE citevia_social_review_links (
  project_id text NOT NULL REFERENCES citevia_projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id,id)
);
CREATE INDEX citevia_social_review_links_expiry ON citevia_social_review_links(project_id,expires_at);

-- Existing restricted application logins receive the same four direct privileges
-- they already hold on publications. New installations grant access at provisioning.
DO $$
DECLARE
  runtime_role name;
BEGIN
  FOR runtime_role IN
    SELECT r.rolname
    FROM pg_catalog.pg_class AS c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
    JOIN pg_catalog.pg_roles AS r ON r.oid = acl.grantee
    WHERE c.oid = 'public.citevia_social_publications'::regclass
      AND r.rolname ~ '^citevia_runtime_[a-z0-9_]{1,40}$'
      AND r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolsuper
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb
      AND NOT r.rolreplication AND NOT r.rolbypassrls
    GROUP BY r.rolname
    HAVING array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type) = ARRAY['DELETE','INSERT','SELECT','UPDATE']
      AND NOT bool_or(acl.is_grantable)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.citevia_social_review_links TO %I', runtime_role);
  END LOOP;
END
$$;
