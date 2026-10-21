-- Extend the native prompt row; historical observations remain immutable.
ALTER TABLE prompts ADD COLUMN seo_keyword text;
-- Failed collection/extraction is missing data, not measured zero visibility.
ALTER TABLE prompt_responses ALTER COLUMN visibility DROP NOT NULL;
ALTER TABLE prompt_responses ALTER COLUMN visibility DROP DEFAULT;
UPDATE prompt_responses SET visibility=NULL WHERE status <> 'COMPLETED';

-- Repair metadata written before the native upsert included these columns.
UPDATE prompts p SET regions=ARRAY[project.data->>'country'], language=project.data->>'language'
FROM citevia_projects project WHERE p.account_id=project.account_id;
