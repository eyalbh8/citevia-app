-- Keep immutable scan manifests out of the hot checkpoint update path.
-- JSON is retained verbatim for old records. The repository overlays this typed
-- state when reading; triggers also accept writes from the previous application.
ALTER TABLE citevia_runs ADD COLUMN succeeded_count integer NOT NULL DEFAULT 0;
ALTER TABLE citevia_runs ADD COLUMN captured_count integer NOT NULL DEFAULT 0;
ALTER TABLE citevia_runs ADD COLUMN started_at timestamptz;
ALTER TABLE citevia_runs ADD COLUMN completed_at timestamptz;
ALTER TABLE citevia_runs ADD COLUMN deadline_at timestamptz;
ALTER TABLE citevia_runs ADD COLUMN summary_key text;
ALTER TABLE citevia_runs ADD COLUMN summary_version integer;

UPDATE citevia_runs SET
  succeeded_count=COALESCE((data->>'succeededCount')::integer,0),
  captured_count=COALESCE((data->>'capturedCount')::integer,0),
  started_at=(data->>'startedAt')::timestamptz,
  completed_at=(data->>'completedAt')::timestamptz,
  deadline_at=(data->>'deadlineAt')::timestamptz,
  summary_key=data->>'summaryKey',
  summary_version=(data->>'summaryVersion')::integer;

CREATE FUNCTION citevia_sync_legacy_run_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.succeeded_count := COALESCE((NEW.data->>'succeededCount')::integer,0);
  NEW.captured_count := COALESCE((NEW.data->>'capturedCount')::integer,0);
  NEW.started_at := (NEW.data->>'startedAt')::timestamptz;
  NEW.completed_at := (NEW.data->>'completedAt')::timestamptz;
  NEW.deadline_at := (NEW.data->>'deadlineAt')::timestamptz;
  NEW.summary_key := NEW.data->>'summaryKey';
  NEW.summary_version := (NEW.data->>'summaryVersion')::integer;
  RETURN NEW;
END;
$$;
CREATE TRIGGER citevia_legacy_run_state BEFORE INSERT OR UPDATE OF data ON citevia_runs
FOR EACH ROW EXECUTE FUNCTION citevia_sync_legacy_run_state();

-- Reanalysis uses the original capture time, never the new run's scheduled time.
ALTER TABLE citevia_prompt_results ADD COLUMN observed_at timestamptz;
ALTER TABLE citevia_prompt_results ADD COLUMN measurement_hash text;
UPDATE citevia_prompt_results result SET observed_at=
  COALESCE(result.data->>'capturedAt',run.data->>'createdAt')::timestamptz
FROM citevia_runs run WHERE run.project_id=result.project_id AND run.id=result.run_id;
ALTER TABLE citevia_prompt_results ALTER COLUMN observed_at SET NOT NULL;

CREATE FUNCTION citevia_sync_observed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data->>'capturedAt' IS NOT NULL THEN
    NEW.observed_at := (NEW.data->>'capturedAt')::timestamptz;
  ELSIF TG_OP='UPDATE' AND OLD.data->>'capturedAt' IS NULL THEN
    NEW.observed_at := OLD.observed_at;
  ELSE
    SELECT (data->>'createdAt')::timestamptz INTO NEW.observed_at FROM citevia_runs
    WHERE project_id=NEW.project_id AND id=NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER citevia_result_observation_time BEFORE INSERT OR UPDATE OF data ON citevia_prompt_results
FOR EACH ROW EXECUTE FUNCTION citevia_sync_observed_at();

CREATE INDEX citevia_results_period_idx ON citevia_prompt_results(project_id,observed_at,run_id);
CREATE INDEX citevia_results_prompt_period_idx ON citevia_prompt_results(project_id,prompt_id,observed_at);
CREATE INDEX citevia_mcp_request_limits_window_idx ON citevia_mcp_request_limits(window_start);
