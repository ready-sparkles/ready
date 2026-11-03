-- Quiesce writers, then remove old protected content and derived copies using an operator-reviewed
-- deletion list before retrying. This migration never deletes rows or accepts plaintext legacy data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "action_items") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "agent_memories") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "agent_tool_invocations") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_workflow_executions") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ashby_meeting_analyses") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ashby_review_actions") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ashby_reviews") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "calendar_event_preps") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "capability_workflow_messages") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "capability_workflow_runs") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "linear_task_review_items") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "linear_task_review_runs") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_ambient_context_items") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_assets") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_capability_recommendations") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_extractions") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_links") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_live_task_candidate_evidence") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_live_task_candidates") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_research_runs") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_suggested_action_runs") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_task_lists") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_tasks") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meeting_trackers") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "meetings") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "memory_evidence") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "memory_generation_ledger") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "memory_person_projections") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "memory_suppressions") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "relationship_memories") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "slack_meeting_reviews") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "summaries") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "transcript_segments") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "transcripts") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "voice_web_research_runs") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "workspace_task_sections") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
  IF EXISTS (SELECT 1 FROM "workspace_tasks") THEN
    RAISE EXCEPTION 'Meeting content cutover requires empty protected tables. Quiesce writers and follow the reviewed content deletion plan before retrying.';
  END IF;
END $$;

-- CONTENT_EXPAND
ALTER TABLE "action_items" ALTER COLUMN "text" TYPE text;
ALTER TABLE "agent_memories" ALTER COLUMN "content" TYPE text;
ALTER TABLE "agent_tool_invocations" ALTER COLUMN "redacted_args" DROP DEFAULT;
ALTER TABLE "agent_tool_invocations" ALTER COLUMN "redacted_result_summary" DROP DEFAULT;
ALTER TABLE "ai_workflow_executions" ALTER COLUMN "error" TYPE text;
ALTER TABLE "ai_workflow_executions" ALTER COLUMN "payload" DROP DEFAULT;
ALTER TABLE "ai_workflow_executions" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "calendar_event_preps" ALTER COLUMN "run_refs" DROP DEFAULT;
ALTER TABLE "calendar_event_preps" ALTER COLUMN "event_snapshot" DROP DEFAULT;
ALTER TABLE "calendar_event_preps" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "capability_workflow_messages" ALTER COLUMN "content" TYPE text;
ALTER TABLE "capability_workflow_messages" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "capability_workflow_runs" ALTER COLUMN "error" TYPE text;
ALTER TABLE "capability_workflow_runs" ALTER COLUMN "context" DROP DEFAULT;
ALTER TABLE "capability_workflow_runs" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "capability_workflow_runs" ALTER COLUMN "draft" DROP DEFAULT;
ALTER TABLE "capability_workflow_runs" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "reasoning" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "title" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "description" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "sync_error" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "external_issue_title" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "external_issue_url" TYPE text;
ALTER TABLE "linear_task_review_items" ALTER COLUMN "duplicate_issues" DROP DEFAULT;
ALTER TABLE "linear_task_review_runs" ALTER COLUMN "error" TYPE text;
ALTER TABLE "linear_task_review_runs" ALTER COLUMN "input_snapshot" DROP DEFAULT;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "canonical_key" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "display_name" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "qualifier" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "professional_title" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "company_name" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "headquarters" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "official_website" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "profile_url" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "summary" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "error" TYPE text;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "facts" DROP DEFAULT;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "citations" DROP DEFAULT;
ALTER TABLE "meeting_ambient_context_items" ALTER COLUMN "facets" DROP DEFAULT;
ALTER TABLE "meeting_assets" ALTER COLUMN "transcript_excerpt" TYPE text;
ALTER TABLE "meeting_capability_recommendations" ALTER COLUMN "reasoning" TYPE text;
ALTER TABLE "meeting_capability_recommendations" ALTER COLUMN "signals_matched" DROP DEFAULT;
ALTER TABLE "meeting_capability_recommendations" ALTER COLUMN "signals_missing" DROP DEFAULT;
ALTER TABLE "meeting_capability_recommendations" ALTER COLUMN "exclusion_signals_checked" DROP DEFAULT;
ALTER TABLE "meeting_capability_recommendations" ALTER COLUMN "payload" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "meeting_type_reasoning" TYPE text;
ALTER TABLE "meeting_extractions" ALTER COLUMN "summary_short" TYPE text;
ALTER TABLE "meeting_extractions" ALTER COLUMN "participants" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "summary_bullets" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "decisions" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "action_items" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "open_questions" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "risks" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "key_topics" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "signals" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "failed_tool_calls" DROP DEFAULT;
ALTER TABLE "meeting_extractions" ALTER COLUMN "highlights" DROP DEFAULT;
ALTER TABLE "meeting_links" ALTER COLUMN "title" TYPE text;
ALTER TABLE "meeting_live_task_candidate_evidence" ALTER COLUMN "full_segment_text" TYPE text;
ALTER TABLE "meeting_live_task_candidate_evidence" ALTER COLUMN "quote" TYPE text;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "title" TYPE text;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "source_reason" TYPE text;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "description" TYPE text;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "due_date_value" TYPE text;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "source_quotes" DROP DEFAULT;
ALTER TABLE "meeting_live_task_candidates" ALTER COLUMN "unresolved_questions" DROP DEFAULT;
ALTER TABLE "meeting_research_runs" ALTER COLUMN "query" TYPE text;
ALTER TABLE "meeting_research_runs" ALTER COLUMN "progress_label" TYPE text;
ALTER TABLE "meeting_research_runs" ALTER COLUMN "progress_detail" TYPE text;
ALTER TABLE "meeting_research_runs" ALTER COLUMN "run_refs" DROP DEFAULT;
ALTER TABLE "meeting_research_runs" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "meeting_suggested_action_runs" ALTER COLUMN "message" TYPE text;
ALTER TABLE "meeting_suggested_action_runs" ALTER COLUMN "error" TYPE text;
ALTER TABLE "meeting_suggested_action_runs" ALTER COLUMN "steps" DROP DEFAULT;
ALTER TABLE "meeting_tasks" ALTER COLUMN "title" TYPE text;
ALTER TABLE "meeting_tasks" ALTER COLUMN "source_reason" TYPE text;
ALTER TABLE "meeting_tasks" ALTER COLUMN "description" TYPE text;
ALTER TABLE "meeting_tasks" ALTER COLUMN "due_date_value" TYPE text;
ALTER TABLE "meeting_tasks" ALTER COLUMN "source_quotes" DROP DEFAULT;
ALTER TABLE "meeting_tasks" ALTER COLUMN "external_links" DROP DEFAULT;
ALTER TABLE "meeting_trackers" ALTER COLUMN "items" DROP DEFAULT;
ALTER TABLE "meetings" ALTER COLUMN "title" TYPE text;
ALTER TABLE "memory_evidence" ALTER COLUMN "quote" TYPE text;
ALTER TABLE "memory_generation_ledger" ALTER COLUMN "error" TYPE text;
ALTER TABLE "relationship_memories" ALTER COLUMN "title" TYPE text;
ALTER TABLE "relationship_memories" ALTER COLUMN "description" TYPE text;
ALTER TABLE "relationship_memories" ALTER COLUMN "candidate_subject_key" TYPE text;
ALTER TABLE "summaries" ALTER COLUMN "content" TYPE text;
ALTER TABLE "transcript_segments" ALTER COLUMN "content" TYPE text;
ALTER TABLE "transcripts" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "voice_web_research_runs" ALTER COLUMN "query" TYPE text;
ALTER TABLE "voice_web_research_runs" ALTER COLUMN "query_key" TYPE text;
ALTER TABLE "voice_web_research_runs" ALTER COLUMN "run_refs" DROP DEFAULT;
ALTER TABLE "voice_web_research_runs" ALTER COLUMN "progress" DROP DEFAULT;
ALTER TABLE "voice_web_research_runs" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "workspace_task_sections" ALTER COLUMN "title" TYPE text;
ALTER TABLE "workspace_tasks" ALTER COLUMN "title" TYPE text;
ALTER TABLE "workspace_tasks" ALTER COLUMN "description" TYPE text;
ALTER TABLE "workspace_tasks" ALTER COLUMN "due_date_value" TYPE text;

ALTER TABLE meeting_ambient_context_items ADD COLUMN canonical_key_fingerprint text, ADD COLUMN error_fingerprint text;
ALTER TABLE voice_web_research_runs ADD COLUMN query_key_fingerprint text, ADD COLUMN query_fingerprint text;
ALTER TABLE workspace_task_sections ADD COLUMN title_fingerprint text;

-- CONTENT_FINALIZE
ALTER TABLE meeting_ambient_context_items ALTER COLUMN canonical_key_fingerprint SET NOT NULL;
ALTER TABLE voice_web_research_runs ALTER COLUMN query_key_fingerprint SET NOT NULL, ALTER COLUMN query_fingerprint SET NOT NULL;
ALTER TABLE workspace_task_sections ALTER COLUMN title_fingerprint SET NOT NULL;
ALTER TABLE meeting_ambient_context_items DROP CONSTRAINT meeting_ambient_context_items_identity_uidx;
ALTER TABLE meeting_ambient_context_items ADD CONSTRAINT meeting_ambient_context_items_identity_uidx UNIQUE (meeting_id, canonical_key_fingerprint);
DROP INDEX voice_web_research_runs_active_query_uidx;
CREATE UNIQUE INDEX voice_web_research_runs_active_query_uidx ON voice_web_research_runs (meeting_id, user_id, query_key_fingerprint)
WHERE ((status)::text <> ALL (ARRAY[('failed'::character varying)::text, ('cancelled'::character varying)::text, ('expired'::character varying)::text, ('completed'::character varying)::text]));
DROP INDEX workspace_task_sections_title_uidx;
CREATE UNIQUE INDEX workspace_task_sections_title_uidx ON workspace_task_sections (workspace_id, title_fingerprint)
WHERE deleted_at IS NULL;
-- Current adapters consolidate and compute plaintext revisions in application memory.
DROP FUNCTION public.link_guest_memory_account(uuid, uuid);
DROP FUNCTION public.consolidate_memory_projections(uuid, uuid);
DROP FUNCTION public.memory_meeting_revision(uuid);
