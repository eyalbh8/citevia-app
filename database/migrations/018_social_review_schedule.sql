-- Prepared posts wait for an owner review, then become due at their approved publishing time.
ALTER TABLE citevia_social_publications
  DROP CONSTRAINT citevia_social_publications_status_check;
ALTER TABLE citevia_social_publications
  ADD CONSTRAINT citevia_social_publications_status_check CHECK (status IN (
    'queued','generating','review_required','scheduled','publishing','published','draft_created','failed','cancelled','uncertain'
  ));
DROP INDEX citevia_social_publications_active_idx;
CREATE INDEX citevia_social_publications_active_idx ON citevia_social_publications(updated_at,id)
  WHERE status IN ('queued','generating','scheduled','publishing');

-- Preserve opt-in and publishing slots; repair old per-slot generation rules into one batch rule.
UPDATE citevia_projects
SET version = version + 1,
    data = data || jsonb_build_object(
      'version', version + 1,
      'updatedAt', to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'socialAutomation', jsonb_build_object('generationCadence','daily','generationTime','08:00')
        || (data->'socialAutomation') || jsonb_build_object('scheduleStatus','pending')
    )
WHERE jsonb_typeof(data->'socialAutomation') = 'object';
