-- Operator-only synthetic load testing. No public route can register a run.
CREATE TABLE load_test_runs (
 id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active' CHECK(status IN('active','stopped','completed')),
 profile text NOT NULL CHECK(profile IN('normal','slow','faults')),
 time_scale double precision NOT NULL DEFAULT 1 CHECK(time_scale>0 AND time_scale<=1),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 stop_reason text, settings jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX load_test_one_active_run ON load_test_runs((true)) WHERE status='active';
-- Keep registration tombstones after fixture cleanup: stale requests must never use a real provider.
CREATE TABLE load_test_meetings (
 meeting_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES load_test_runs(id), ordinal integer NOT NULL,
 workspace_id uuid NOT NULL, user_ids uuid[] NOT NULL, transcript_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), cleaned_at timestamptz
);
CREATE INDEX load_test_meetings_run ON load_test_meetings(run_id);
CREATE TABLE load_test_jobs (
 job_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES load_test_runs(id), meeting_id uuid NOT NULL REFERENCES load_test_meetings(meeting_id),
 queue text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE load_test_calls (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES load_test_runs(id), meeting_id uuid NOT NULL REFERENCES load_test_meetings(meeting_id),
 operation text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, outcome text
);
CREATE TABLE load_test_samples (
 id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES load_test_runs(id), service text NOT NULL,
 sampled_at timestamptz NOT NULL DEFAULT now(), metrics jsonb NOT NULL
);
CREATE FUNCTION register_load_test_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid;
BEGIN
 IF TG_TABLE_NAME='ai_workflow_jobs' THEN mid=NEW.meeting_id;
 ELSE SELECT meeting_id INTO mid FROM memory_sources WHERE id=NEW.source_id; END IF;
 INSERT INTO load_test_jobs(job_id,run_id,meeting_id,queue)
 SELECT NEW.id,run_id,meeting_id,TG_TABLE_NAME FROM load_test_meetings WHERE meeting_id=mid
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER load_test_ai_job AFTER INSERT ON ai_workflow_jobs FOR EACH ROW EXECUTE FUNCTION register_load_test_job();
CREATE TRIGGER load_test_memory_job AFTER INSERT ON memory_jobs FOR EACH ROW EXECUTE FUNCTION register_load_test_job();
