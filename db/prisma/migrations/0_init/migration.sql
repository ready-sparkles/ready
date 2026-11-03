-- Fresh installations only. Generated from unseeded migration history at cf06fed6.
-- Existing fully migrated databases adopt this baseline without executing it.
--
-- PostgreSQL database dump
--



SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL standard_conforming_strings = on;
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: allocate_completed_meeting_trial_slot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.allocate_completed_meeting_trial_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE m meetings%ROWTYPE; next_slot smallint; notes_workspace_id uuid;
BEGIN
 SELECT * INTO m FROM meetings WHERE id=NEW.meeting_id;
 IF m.kind<>'standard' OR m.status<>'ended' OR m.hidden_from_history_reason IS NOT NULL
   OR m.started_at IS NULL OR m.ended_at<m.started_at+interval '10 seconds'
   OR NEW.model IN ('short-meeting-v1','fallback-summary-v1') THEN RETURN NEW; END IF;
 SELECT coalesce((SELECT a.workspace_id FROM meeting_attendee_workspaces a
   WHERE a.meeting_id=m.id AND a.user_id=m.created_by_user_id),m.workspace_id) INTO notes_workspace_id;
 IF EXISTS(SELECT 1 FROM meeting_trial_slots WHERE user_id=m.created_by_user_id AND meeting_id=m.id) THEN RETURN NEW; END IF;
 SELECT candidate INTO next_slot FROM generate_series(1,3) candidate
   WHERE NOT EXISTS(SELECT 1 FROM meeting_trial_slots t WHERE t.user_id=m.created_by_user_id
     AND t.workspace_id=notes_workspace_id AND t.slot=candidate) ORDER BY candidate LIMIT 1;
 IF next_slot IS NOT NULL THEN
   INSERT INTO meeting_trial_slots(user_id,workspace_id,meeting_id,slot)
     VALUES(m.created_by_user_id,notes_workspace_id,m.id,next_slot);
 END IF;
 RETURN NEW;
END $$;


--
-- Name: canonical_memory_person(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_memory_person(id uuid) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
 SELECT coalesce((SELECT target_person_id FROM memory_person_redirects WHERE person_id=id),id)
$$;


--
-- Name: canonicalize_memory_people_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonicalize_memory_people_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 NEW.person_ids=ARRAY(SELECT DISTINCT canonical_memory_person(id) FROM unnest(NEW.person_ids) id);
 NEW.candidate_subject_id=canonical_memory_person(NEW.candidate_subject_id);
 RETURN NEW;
END $$;


--
-- Name: capture_attendee_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_attendee_workspace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM record_meeting_attendee_workspace(NEW.meeting_id,NEW.user_id);
 RETURN NEW;
END $$;


--
-- Name: consolidate_memory_projections(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consolidate_memory_projections(winner uuid, loser uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
 WITH valid AS MATERIALIZED (
  SELECT p.* FROM memory_person_projections p
  WHERE p.person_id IN(winner,loser) AND p.source_revisions IS NOT NULL
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_each_text(p.source_revisions) evidence
    WHERE NOT EXISTS(SELECT 1 FROM memory_sources s JOIN memory_people person ON person.id=winner
     WHERE s.id::text=evidence.key AND s.user_id=person.user_id AND s.workspace_id=person.workspace_id
      AND s.is_current AND s.revision=evidence.value AND memory_meeting_revision(s.meeting_id)=evidence.value))
 ), entries AS (
  SELECT DISTINCT section,entry FROM valid p
  CROSS JOIN unnest(ARRAY['summary','standing']) section
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.content->section,'[]'::jsonb)) entry
  WHERE jsonb_array_length(coalesce(entry->'memoryIds','[]'::jsonb))>0
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(entry->'memoryIds') ref
    WHERE NOT EXISTS(SELECT 1 FROM relationship_memories m
     WHERE m.id::text=ref AND winner=ANY(m.person_ids) AND p.source_revisions ? m.source_id::text))
 ), revisions AS (
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) value
  FROM (SELECT DISTINCT key,value FROM valid CROSS JOIN LATERAL jsonb_each(source_revisions)) r
 )
 INSERT INTO memory_person_projections(person_id,input_hash,content,prompt_version,source_revisions)
 SELECT winner,'consolidated:'||gen_random_uuid()::text,
  jsonb_build_object(
   'summary',coalesce((SELECT jsonb_agg(entry ORDER BY entry::text) FROM entries WHERE section='summary'),'[]'::jsonb),
   'standing',coalesce((SELECT jsonb_agg(entry ORDER BY entry::text) FROM entries WHERE section='standing'),'[]'::jsonb)),
  (SELECT prompt_version FROM valid ORDER BY updated_at DESC LIMIT 1),revisions.value
 FROM revisions WHERE EXISTS(SELECT 1 FROM valid)
 ON CONFLICT(person_id) DO UPDATE SET input_hash=excluded.input_hash,content=excluded.content,
  prompt_version=excluded.prompt_version,source_revisions=excluded.source_revisions,updated_at=now();
 DELETE FROM memory_person_projections WHERE person_id=loser;
END $$;


--
-- Name: debit_ai_usage_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.debit_ai_usage_credits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  account users%ROWTYPE;
  subscription billing_subscriptions%ROWTYPE;
  grant_row credit_grants%ROWTYPE;
  remaining integer := GREATEST(NEW.credits_charged, 0);
  debit integer;
  pool_balance bigint;
  used_before bigint;
  allowance integer := 0;
  active_member boolean;
  use_workspace boolean := false;
  anchor timestamp;
  window_start timestamptz;
  window_end timestamptz;
  window_index integer := 0;
BEGIN
  IF remaining = 0 THEN RETURN NEW; END IF;
  -- User first, then workspace: a consistent lock order also covers legacy grants.
  SELECT * INTO account FROM users WHERE id = NEW.user_id FOR NO KEY UPDATE;
  IF account.plan <> 'free' AND account.private_beta_pro_enabled_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM billing_subscriptions WHERE user_id = NEW.user_id AND workspace_id IS NULL
      AND (status IN ('active', 'trialing') OR (status = 'past_due' AND status_changed_at > now() - interval '7 days'))
      AND (current_period_end IS NULL OR current_period_end > now())
    ) THEN RETURN NEW;
  END IF;
  IF NEW.workspace_id IS NOT NULL THEN
    PERFORM id FROM workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE;
    SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id = NEW.user_id
      AND workspace_id = NEW.workspace_id AND status = 'active') INTO active_member;
    SELECT * INTO subscription FROM billing_subscriptions WHERE workspace_id = NEW.workspace_id
      AND (status IN ('active', 'trialing') OR (status = 'past_due' AND status_changed_at > now() - interval '7 days'))
      AND (current_period_end IS NULL OR current_period_end > now())
      ORDER BY updated_at DESC LIMIT 1;
    IF FOUND THEN
      use_workspace := true;
      IF active_member AND subscription.current_period_start IS NOT NULL THEN
        anchor := subscription.current_period_start AT TIME ZONE 'UTC';
        window_start := subscription.current_period_start;
        window_end := (anchor + interval '1 month') AT TIME ZONE 'UTC';
        WHILE now() >= window_end AND window_index < 12 LOOP
          window_index := window_index + 1;
          window_start := (anchor + make_interval(months => window_index)) AT TIME ZONE 'UTC';
          window_end := (anchor + make_interval(months => window_index + 1)) AT TIME ZONE 'UTC';
        END LOOP;
        window_end := LEAST(window_end, COALESCE(subscription.current_period_end, window_end));
        IF now() >= window_start AND now() < window_end THEN
          SELECT COALESCE(sum(credits_charged), 0) INTO used_before FROM ai_credit_usage_events
            WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND id <> NEW.id
            AND created_at >= window_start AND created_at < window_end;
          allowance := LEAST(remaining, GREATEST(0, subscription.included_credits_per_period - used_before));
          remaining := remaining - allowance;
        END IF;
      END IF;
    ELSE
      SELECT COALESCE(sum(credits_remaining), 0) INTO pool_balance FROM credit_grants
        WHERE workspace_id = NEW.workspace_id AND credits_remaining > 0
        AND (expires_at IS NULL OR expires_at > now());
      use_workspace := active_member AND pool_balance >= remaining;
    END IF;
  END IF;
  FOR grant_row IN SELECT * FROM credit_grants
    WHERE credits_remaining > 0 AND (expires_at IS NULL OR expires_at > now())
      AND ((use_workspace AND workspace_id = NEW.workspace_id) OR (NOT use_workspace AND user_id = NEW.user_id))
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC FOR UPDATE
  LOOP
    EXIT WHEN remaining <= 0;
    debit := LEAST(remaining, grant_row.credits_remaining);
    UPDATE credit_grants SET credits_remaining = credits_remaining - debit, updated_at = now() WHERE id = grant_row.id;
    remaining := remaining - debit;
  END LOOP;
  IF NEW.require_available_credits AND remaining > 0 THEN
    RAISE EXCEPTION 'Insufficient AI credits';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enforce_memory_attendee_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_memory_attendee_workspace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.meeting_id IS NOT NULL AND NOT meeting_in_attendee_workspace(NEW.meeting_id,NEW.user_id,NEW.workspace_id) THEN
  RAISE EXCEPTION 'Memory source belongs to another attendee workspace' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: invalidate_meeting_memories(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_meeting_memories() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE tid uuid; mid uuid;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.transcript_id,NEW.speaker_user_id,NEW.speaker_name,NEW.speaker_role,NEW.content,NEW.started_at)
  IS NOT DISTINCT FROM ROW(OLD.id,OLD.transcript_id,OLD.speaker_user_id,OLD.speaker_name,OLD.speaker_role,OLD.content,OLD.started_at) THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN tid=OLD.transcript_id; ELSE tid=NEW.transcript_id; END IF;
 SELECT meeting_id INTO mid FROM transcripts WHERE id=tid;
 UPDATE memory_sources SET is_current=false WHERE meeting_id=mid;
 IF TG_OP='UPDATE' AND OLD.transcript_id IS DISTINCT FROM NEW.transcript_id THEN
  UPDATE memory_sources SET is_current=false WHERE meeting_id=(SELECT meeting_id FROM transcripts WHERE id=OLD.transcript_id);
 END IF;
 RETURN NULL;
END $$;


--
-- Name: invalidate_memory_transcript_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_memory_transcript_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE memory_sources SET is_current=false WHERE meeting_id=OLD.meeting_id;
 RETURN OLD;
END $$;


--
-- Name: link_guest_memory_account(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_guest_memory_account(guest_id uuid, account_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE browser_id uuid; account_name text; account_email text; scope record; winner uuid; loser record;
BEGIN
 SELECT display_name,lower(trim(email)) INTO account_name,account_email FROM users WHERE id=account_id AND source IN('auth','dev_login') AND deleted_at IS NULL;
 IF account_name IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=guest_id AND source='guest') THEN
  RAISE EXCEPTION 'Invalid guest account link';
 END IF;
 SELECT b.browser_id INTO browser_id FROM guest_browser_users b WHERE b.guest_user_id=guest_id;
 IF EXISTS(SELECT 1 FROM guest_memory_account_links WHERE guest_user_id=guest_id AND account_user_id<>account_id)
 OR EXISTS(SELECT 1 FROM guest_browser_identities WHERE id=browser_id AND linked_account_user_id IS NOT NULL AND linked_account_user_id<>account_id) THEN
  RAISE EXCEPTION 'Guest recognition is already linked to another account' USING ERRCODE='23505';
 END IF;
 INSERT INTO guest_memory_account_links VALUES(guest_id,account_id) ON CONFLICT DO NOTHING;
 UPDATE guest_browser_identities SET linked_account_user_id=account_id WHERE id=browser_id;
 FOR scope IN
  SELECT DISTINCT i.user_id,i.workspace_id FROM memory_person_identities i
  WHERE ((i.kind='user_id' AND i.identity IN(guest_id::text,account_id::text)) OR (i.kind='verified_email' AND lower(trim(i.identity))=account_email))
   OR (i.kind='guest_browser' AND i.identity IN(SELECT id::text FROM guest_browser_identities WHERE linked_account_user_id=account_id))
  ORDER BY i.user_id,i.workspace_id
 LOOP
  -- Keep the guest/browser person already shown to this owner whenever possible.
  SELECT i.person_id INTO winner FROM memory_person_identities i
  WHERE i.user_id=scope.user_id AND i.workspace_id=scope.workspace_id AND
   (((i.kind='user_id' AND i.identity IN(guest_id::text,account_id::text)) OR (i.kind='verified_email' AND lower(trim(i.identity))=account_email)) OR
    (i.kind='guest_browser' AND i.identity IN(SELECT id::text FROM guest_browser_identities WHERE linked_account_user_id=account_id)))
  ORDER BY CASE WHEN i.kind='guest_browser' AND i.identity=browser_id::text THEN 0
    WHEN i.kind='user_id' AND i.identity=guest_id::text THEN 1 ELSE 2 END,i.person_id LIMIT 1;
  -- Preserve an observed guest spelling even for guests who never opted into browser recognition.
  INSERT INTO memory_person_names(person_id,source_id,participant_user_id,name,normalized_name,word_count,observed_at)
   SELECT winner,mi.source_id,guest_id,u.display_name,lower(trim(u.display_name)),
    CASE WHEN lower(trim(u.display_name))='guest' THEN 0 ELSE cardinality(regexp_split_to_array(trim(u.display_name),'\s+')) END,mi.occurred_at
   FROM memory_interactions mi JOIN memory_person_identities gi ON gi.person_id=mi.person_id
   JOIN users u ON u.id=guest_id
   WHERE gi.user_id=scope.user_id AND gi.workspace_id=scope.workspace_id AND gi.kind='user_id' AND gi.identity=guest_id::text
   ON CONFLICT DO NOTHING;
  FOR loser IN
   SELECT DISTINCT i.person_id FROM memory_person_identities i
   WHERE i.user_id=scope.user_id AND i.workspace_id=scope.workspace_id AND i.person_id<>winner AND
    (((i.kind='user_id' AND i.identity IN(guest_id::text,account_id::text)) OR (i.kind='verified_email' AND lower(trim(i.identity))=account_email)) OR
     (i.kind='guest_browser' AND i.identity IN(SELECT id::text FROM guest_browser_identities WHERE linked_account_user_id=account_id)))
  LOOP
   INSERT INTO memory_interactions SELECT source_id,winner,occurred_at FROM memory_interactions WHERE person_id=loser.person_id ON CONFLICT DO NOTHING;
   DELETE FROM memory_interactions WHERE person_id=loser.person_id;
   INSERT INTO memory_person_names SELECT winner,source_id,participant_user_id,name,normalized_name,word_count,observed_at FROM memory_person_names WHERE person_id=loser.person_id ON CONFLICT DO NOTHING;
   DELETE FROM memory_person_names WHERE person_id=loser.person_id;
   UPDATE memory_person_identities SET person_id=winner WHERE person_id=loser.person_id;
   UPDATE memory_person_redirects SET target_person_id=winner WHERE target_person_id=loser.person_id;
   INSERT INTO memory_person_redirects VALUES(loser.person_id,winner) ON CONFLICT(person_id) DO UPDATE SET target_person_id=excluded.target_person_id;
   UPDATE relationship_memories SET person_ids=array_replace(person_ids,loser.person_id,winner),
    candidate_subject_id=CASE WHEN candidate_subject_id=loser.person_id THEN winner ELSE candidate_subject_id END
    WHERE loser.person_id=ANY(person_ids) OR candidate_subject_id=loser.person_id;
   PERFORM consolidate_memory_projections(winner,loser.person_id);
  END LOOP;
  INSERT INTO memory_person_identities VALUES(winner,scope.user_id,scope.workspace_id,'user_id',account_id::text) ON CONFLICT DO NOTHING;
  UPDATE memory_people SET name=account_name WHERE id=winner;
 END LOOP;
END $$;


--
-- Name: mark_memory_sync_change(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_memory_sync_change(p_memory_id uuid, p_source_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id uuid; owner_workspace uuid; next_version bigint;
BEGIN
  SELECT s.user_id, s.workspace_id INTO owner_id, owner_workspace
  FROM memory_sources s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.id=s.workspace_id
  WHERE s.id=p_source_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO memory_sync_heads(user_id, workspace_id, version) VALUES(owner_id, owner_workspace, 1)
  ON CONFLICT(user_id, workspace_id) DO UPDATE SET version=memory_sync_heads.version+1
  RETURNING version INTO next_version;
  INSERT INTO memory_sync_changes(user_id, workspace_id, memory_id, source_id, version)
  VALUES(owner_id, owner_workspace, p_memory_id, p_source_id, next_version)
  ON CONFLICT(user_id, workspace_id, memory_id) DO UPDATE
  SET source_id=excluded.source_id, version=excluded.version;
END $$;


--
-- Name: meeting_in_attendee_workspace(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.meeting_in_attendee_workspace(meeting uuid, attendee uuid, workspace uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM meetings m WHERE m.id=meeting AND
  coalesce((SELECT a.workspace_id FROM meeting_attendee_workspaces a WHERE a.meeting_id=m.id AND a.user_id=attendee),m.workspace_id)=workspace)
$$;


--
-- Name: memory_meeting_revision(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.memory_meeting_revision(mid uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
 SELECT md5(coalesce(string_agg(jsonb_build_array(s.id,s.speaker_user_id,s.speaker_name,s.speaker_role,s.content,s.started_at)::text,'' ORDER BY s.started_at,s.id),''))
 FROM transcripts t JOIN transcript_segments s ON s.transcript_id=t.id WHERE t.meeting_id=mid
$$;


--
-- Name: prevent_redirected_memory_projection(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_redirected_memory_projection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM memory_person_redirects WHERE person_id=NEW.person_id) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;


--
-- Name: record_meeting_attendee_workspace(uuid, uuid, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_meeting_attendee_workspace(meeting uuid, attendee uuid, selected_workspace uuid DEFAULT NULL::uuid, allow_ended boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM meeting_attendee_workspaces a WHERE a.meeting_id=meeting AND a.user_id=attendee) THEN RETURN; END IF;
 -- The selected workspace comes from authenticated server context, not a body
 -- field. Recheck membership here so stale sessions cannot assign other scopes.
 IF selected_workspace IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=attendee AND wm.workspace_id=selected_workspace AND wm.status='active'
 ) THEN RAISE EXCEPTION 'Inactive attendee workspace' USING ERRCODE='23503'; END IF;
 INSERT INTO meeting_attendee_workspaces(meeting_id,user_id,workspace_id,assignment)
 SELECT m.id,u.id,destination.workspace_id,
  CASE WHEN destination.workspace_id=m.workspace_id THEN 'host_workspace' ELSE 'joined_workspace' END
 FROM meetings m JOIN users u ON u.id=attendee
 CROSS JOIN LATERAL (
  SELECT wm.workspace_id FROM workspace_memberships wm
  WHERE wm.user_id=u.id AND wm.status='active'
  ORDER BY (wm.workspace_id=m.workspace_id) DESC,
   (wm.workspace_id=coalesce(selected_workspace,u.active_workspace_id)) DESC NULLS LAST,
   wm.created_at,wm.workspace_id LIMIT 1
 ) destination
 WHERE m.id=meeting AND (m.status<>'ended' OR (allow_ended AND EXISTS(
   SELECT 1 FROM meeting_attendance_intervals a WHERE a.meeting_id=m.id AND a.user_id=attendee AND a.joined_at<m.ended_at
  ))) AND u.deleted_at IS NULL AND u.source IN('auth','dev_login')
  AND NOT EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=u.id AND wm.workspace_id=m.workspace_id AND wm.status='suspended')
 ON CONFLICT(meeting_id,user_id) DO NOTHING;
END $$;


--
-- Name: record_memory_attendance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_memory_attendance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.role NOT IN ('host','guest') OR NEW.joined_at<'2000-01-01' THEN RETURN NEW; END IF;
 IF NEW.left_at IS NULL AND EXISTS(SELECT 1 FROM meetings WHERE id=NEW.meeting_id AND status<>'ended') THEN
  IF TG_OP='UPDATE' AND NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
   UPDATE meeting_attendance_intervals SET left_at=greatest(joined_at,NEW.joined_at) WHERE meeting_id=NEW.meeting_id AND user_id=NEW.user_id AND left_at IS NULL;
  END IF;
  INSERT INTO meeting_attendance_intervals(meeting_id,user_id,joined_at) VALUES(NEW.meeting_id,NEW.user_id,NEW.joined_at) ON CONFLICT DO NOTHING;
 ELSIF NEW.left_at IS NOT NULL THEN
  UPDATE meeting_attendance_intervals SET left_at=greatest(joined_at,NEW.left_at) WHERE meeting_id=NEW.meeting_id AND user_id=NEW.user_id AND left_at IS NULL;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: record_memory_sensitivity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_memory_sensitivity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO memory_sensitivity_history VALUES(NEW.user_id,NEW.workspace_id,'-infinity',false);
  IF NOT NEW.include_sensitive THEN RETURN NEW; END IF;
 ELSIF NEW.include_sensitive=OLD.include_sensitive THEN
  RETURN NEW;
 END IF;
 INSERT INTO memory_sensitivity_history VALUES(NEW.user_id,NEW.workspace_id,clock_timestamp(),NEW.include_sensitive);
 RETURN NEW;
END $$;


--
-- Name: remove_attendee_workspace_memory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_attendee_workspace_memory() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 DELETE FROM memory_sources WHERE meeting_id=OLD.meeting_id AND user_id=OLD.user_id AND workspace_id=OLD.workspace_id;
 RETURN OLD;
END $$;


--
-- Name: track_memory_sync_evidence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_memory_sync_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target_id uuid; source uuid;
BEGIN
  target_id := CASE WHEN TG_OP='DELETE' THEN OLD.memory_id ELSE NEW.memory_id END;
  SELECT source_id INTO source FROM relationship_memories WHERE id=target_id;
  IF FOUND THEN PERFORM mark_memory_sync_change(target_id, source); END IF;
  IF TG_OP='UPDATE' AND OLD.memory_id<>NEW.memory_id THEN
    SELECT source_id INTO source FROM relationship_memories WHERE id=OLD.memory_id;
    IF FOUND THEN PERFORM mark_memory_sync_change(OLD.memory_id, source); END IF;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: track_memory_sync_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_memory_sync_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM mark_memory_sync_change(OLD.id, OLD.source_id);
    RETURN OLD;
  END IF;
  PERFORM mark_memory_sync_change(NEW.id, NEW.source_id);
  RETURN NEW;
END $$;


--
-- Name: track_memory_sync_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_memory_sync_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE memory_id uuid;
BEGIN
  IF OLD.is_current IS DISTINCT FROM NEW.is_current OR OLD.include_sensitive IS DISTINCT FROM NEW.include_sensitive THEN
    FOR memory_id IN SELECT id FROM relationship_memories WHERE source_id=NEW.id ORDER BY id LOOP
      PERFORM mark_memory_sync_change(memory_id, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: track_memory_sync_source_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_memory_sync_source_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE memory_id uuid;
BEGIN
  FOR memory_id IN SELECT id FROM relationship_memories WHERE source_id=OLD.id ORDER BY id LOOP
    PERFORM mark_memory_sync_change(memory_id, OLD.id);
  END LOOP;
  RETURN OLD;
END $$;


SET LOCAL default_tablespace = '';

SET LOCAL default_table_access_method = heap;

--
-- Name: acquisition_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acquisition_payments (
    transaction_id text NOT NULL,
    user_id uuid,
    workspace_id uuid,
    amount_minor bigint NOT NULL,
    currency text NOT NULL,
    paid_at timestamp with time zone NOT NULL,
    CONSTRAINT acquisition_payments_amount_minor_check CHECK ((amount_minor > 0))
);


--
-- Name: action_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    text text NOT NULL,
    assignee character varying(120),
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_user_plan_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_user_plan_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    target_user_id uuid NOT NULL,
    previous_plan text NOT NULL,
    next_plan text NOT NULL,
    source character varying(32) DEFAULT 'admin_manual'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_connector_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_connector_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_connector_id uuid NOT NULL,
    secret_ref text NOT NULL,
    encryption_version character varying(32) DEFAULT 'v1'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone
);


--
-- Name: agent_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_profile_id uuid NOT NULL,
    provider character varying(64) NOT NULL,
    status character varying(32) DEFAULT 'disconnected'::character varying NOT NULL,
    scope character varying(32) DEFAULT 'private'::character varying NOT NULL,
    external_account_email character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_account_id text,
    provider_email character varying(255),
    provider_tenant_id character varying(255),
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    sync_status character varying(64) DEFAULT 'idle'::character varying NOT NULL,
    account_kind character varying(32),
    connected_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    disconnected_at timestamp with time zone,
    deleted_at timestamp with time zone,
    null_account_key text GENERATED ALWAYS AS (
CASE
    WHEN ((provider_account_id IS NULL) AND (deleted_at IS NULL)) THEN (((user_id)::text || ':'::text) || (provider)::text)
    ELSE NULL::text
END) STORED,
    active_account_key text GENERATED ALWAYS AS (
CASE
    WHEN ((provider_account_id IS NOT NULL) AND (deleted_at IS NULL)) THEN (((((user_id)::text || ':'::text) || (provider)::text) || ':'::text) || provider_account_id)
    ELSE NULL::text
END) STORED
);


--
-- Name: agent_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_profile_id uuid NOT NULL,
    memory_type character varying(64) NOT NULL,
    content text NOT NULL,
    source character varying(64) DEFAULT 'manual'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    display_name character varying(120) NOT NULL,
    system_prompt text,
    voice_provider character varying(64) DEFAULT 'openai'::character varying NOT NULL,
    voice_id character varying(120),
    llm_model character varying(120),
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    default_profile_key text GENERATED ALWAYS AS (
CASE
    WHEN is_default THEN (user_id)::text
    ELSE NULL::text
END) STORED
);


--
-- Name: agent_tool_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_invocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    utterance_id character varying(160) NOT NULL,
    user_id uuid NOT NULL,
    agent_profile_id uuid NOT NULL,
    connector_id uuid,
    provider character varying(64) NOT NULL,
    tool_name character varying(120) NOT NULL,
    tool_version character varying(32) NOT NULL,
    policy_version character varying(64) NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    confirmation_status character varying(32) DEFAULT 'not_required'::character varying NOT NULL,
    confirmation_actor_user_id uuid,
    idempotency_key character varying(180),
    redacted_args jsonb DEFAULT '{}'::jsonb NOT NULL,
    redacted_result_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code character varying(120),
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone,
    executed_at timestamp with time zone
);


--
-- Name: agent_tool_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_profile_id uuid NOT NULL,
    tool_name character varying(120) NOT NULL,
    mode character varying(32) DEFAULT 'private'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_credit_pricing_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_credit_pricing_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    price_per_credit_micro_usd integer DEFAULT 100000 NOT NULL,
    target_markup_multiplier numeric(8,4) DEFAULT 5 NOT NULL,
    included_action_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    action_minimum_credits jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_credit_pricing_config_price_per_credit_micro_usd_check CHECK ((price_per_credit_micro_usd > 0)),
    CONSTRAINT ai_credit_pricing_config_target_markup_multiplier_check CHECK ((target_markup_multiplier >= (0)::numeric))
);


--
-- Name: ai_credit_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_credit_usage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    meeting_id uuid,
    job_id uuid,
    workflow_run_id uuid,
    action_type text NOT NULL,
    action_label text NOT NULL,
    provider text,
    model text,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cached_input_tokens integer DEFAULT 0 NOT NULL,
    tool_call_count integer DEFAULT 0 NOT NULL,
    actual_cost_micro_usd integer DEFAULT 0 NOT NULL,
    price_per_credit_micro_usd integer DEFAULT 100000 NOT NULL,
    markup_multiplier numeric(8,4) DEFAULT 5 NOT NULL,
    minimum_credits integer DEFAULT 1 NOT NULL,
    included boolean DEFAULT false NOT NULL,
    credits_charged integer DEFAULT 0 NOT NULL,
    revenue_micro_usd integer DEFAULT 0 NOT NULL,
    profit_micro_usd integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid,
    require_available_credits boolean DEFAULT false NOT NULL,
    CONSTRAINT ai_credit_usage_events_markup_multiplier_check CHECK ((markup_multiplier >= (0)::numeric)),
    CONSTRAINT ai_credit_usage_events_price_per_credit_micro_usd_check CHECK ((price_per_credit_micro_usd > 0))
);


--
-- Name: ai_workflow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_workflow_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    extraction_id uuid,
    type text NOT NULL,
    scope_key character varying(160) DEFAULT 'default'::character varying NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    phase character varying(64) DEFAULT 'running'::character varying NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preview_key text GENERATED ALWAYS AS (
CASE
    WHEN ((type = 'resolve_meeting_title'::text) AND ((scope_key)::text = 'guest-preview-v1'::text) AND (status = ANY (ARRAY['running'::text, 'queued'::text, 'completed'::text]))) THEN (meeting_id)::text
    ELSE NULL::text
END) STORED
);


--
-- Name: ashby_candidate_email_lookups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ashby_candidate_email_lookups (
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    candidate_id text,
    profile_url text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ashby_meeting_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ashby_meeting_analyses (
    meeting_id uuid NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ashby_member_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ashby_member_connections (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ashby_review_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ashby_review_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    kind text NOT NULL,
    target_id text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ashby_review_actions_kind_check CHECK ((kind = 'stage'::text)),
    CONSTRAINT ashby_review_actions_status_check CHECK ((status = ANY (ARRAY['unknown'::text, 'completed'::text, 'rejected'::text])))
);


--
-- Name: ashby_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ashby_reviews (
    id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    review jsonb NOT NULL,
    command jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assigned_task_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assigned_task_placements (
    source_type text NOT NULL,
    source_task_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    assignee_user_id uuid NOT NULL,
    section_id uuid NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_by_user_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_checkout_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_checkout_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type character varying(16) NOT NULL,
    subject_id uuid NOT NULL,
    checkout_kind character varying(16) NOT NULL,
    request_key character varying(255) NOT NULL,
    request_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    stripe_checkout_session_id character varying(255),
    checkout_url text,
    expires_at timestamp with time zone,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pending_checkout_key text GENERATED ALWAYS AS (
CASE
    WHEN ((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying])::text[])) THEN (((((subject_type)::text || ':'::text) || (subject_id)::text) || ':'::text) || (checkout_kind)::text)
    ELSE NULL::text
END) STORED,
    CONSTRAINT billing_checkout_attempts_kind_check CHECK (((checkout_kind)::text = ANY ((ARRAY['subscription'::character varying, 'topup'::character varying])::text[]))),
    CONSTRAINT billing_checkout_attempts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'expired'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT billing_checkout_attempts_subject_type_check CHECK (((subject_type)::text = ANY ((ARRAY['user'::character varying, 'workspace'::character varying])::text[])))
);


--
-- Name: billing_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_customers (
    user_id uuid NOT NULL,
    stripe_customer_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    stripe_subscription_id character varying(255) NOT NULL,
    stripe_price_id character varying(255) NOT NULL,
    status character varying(64) NOT NULL,
    plan_interval character varying(16) NOT NULL,
    included_credits_per_period integer DEFAULT 0 NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid,
    seat_quantity integer DEFAULT 1 NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_event_preps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_preps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    calendar_event_id text NOT NULL,
    event_fingerprint text NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    taskgroup_id character varying(160),
    run_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    event_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    calendar_account_id uuid,
    legacy_fingerprint_key text GENERATED ALWAYS AS (
CASE
    WHEN (calendar_account_id IS NULL) THEN (((((user_id)::text || ':'::text) || calendar_event_id) || ':'::text) || event_fingerprint)
    ELSE NULL::text
END) STORED
);


--
-- Name: calendar_ready_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_ready_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    calendar_account_id uuid NOT NULL,
    provider character varying(64) NOT NULL,
    calendar_id text NOT NULL,
    provider_event_id text NOT NULL,
    meeting_link_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_sync_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_sync_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_connector_id uuid NOT NULL,
    provider character varying(64) NOT NULL,
    calendar_id character varying(255) DEFAULT 'primary'::character varying NOT NULL,
    channel_id character varying(64) NOT NULL,
    resource_id character varying(255),
    resource_uri text,
    expiration_at timestamp with time zone,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    last_message_number text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    webhook_address text,
    active_calendar_key text GENERATED ALWAYS AS (
CASE
    WHEN ((status)::text = 'active'::text) THEN (((agent_connector_id)::text || ':'::text) || (calendar_id)::text)
    ELSE NULL::text
END) STORED
);


--
-- Name: capability_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key character varying(160) NOT NULL,
    name character varying(255) NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    applicable_meeting_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_signals jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclusion_signals jsonb DEFAULT '[]'::jsonb NOT NULL,
    example_triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    side_effect_scope text NOT NULL,
    default_priority integer DEFAULT 50 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: capability_workflow_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_workflow_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_run_id uuid NOT NULL,
    role character varying(32) NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: capability_workflow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_workflow_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    recommendation_id uuid NOT NULL,
    capability_key character varying(160) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    phase character varying(64) DEFAULT 'gathering_context'::character varying NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    draft jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: credit_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    source text NOT NULL,
    credits integer NOT NULL,
    credits_remaining integer NOT NULL,
    expires_at timestamp with time zone,
    stripe_reference text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid,
    CONSTRAINT credit_grants_subject_check CHECK (((user_id IS NULL) <> (workspace_id IS NULL)))
);


--
-- Name: data_deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    target_kind character varying(64) NOT NULL,
    target_provider character varying(64),
    target_account_id uuid,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    provider_revocation_status jsonb DEFAULT '{}'::jsonb NOT NULL,
    error jsonb,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    calendar_deleted_at timestamp with time zone,
    attachments_deleted_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_addon_conferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_addon_conferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    idempotency_key character varying(64) NOT NULL,
    meeting_link_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guest_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    meeting_link_id uuid NOT NULL,
    meeting_id uuid,
    join_request_id uuid NOT NULL,
    secret_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    linked_to_user_id uuid,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guest_browser_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_browser_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    notice_version text NOT NULL,
    purpose text NOT NULL,
    consented_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    linked_account_user_id uuid
);


--
-- Name: guest_browser_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_browser_users (
    guest_user_id uuid NOT NULL,
    browser_id uuid NOT NULL,
    associated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guest_memory_account_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_memory_account_links (
    guest_user_id uuid NOT NULL,
    account_user_id uuid NOT NULL
);


--
-- Name: linear_task_review_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linear_task_review_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    "position" integer NOT NULL,
    source_task_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    decision character varying(24) NOT NULL,
    confidence integer NOT NULL,
    reasoning text NOT NULL,
    title character varying(160) NOT NULL,
    description text,
    team_id text,
    team_name text,
    included boolean DEFAULT true NOT NULL,
    sync_status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    sync_error text,
    external_issue_id text,
    external_issue_identifier text,
    external_issue_title text,
    external_issue_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issue_draft jsonb,
    duplicate_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    target_action character varying(32) DEFAULT 'create'::character varying NOT NULL,
    target_issue jsonb,
    relation_id text,
    meeting_context_synced_at timestamp with time zone,
    CONSTRAINT linear_task_review_items_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100)))
);


--
-- Name: linear_task_review_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linear_task_review_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    task_list_id uuid NOT NULL,
    user_id uuid NOT NULL,
    connector_id uuid,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    phase character varying(64) DEFAULT 'queued'::character varying NOT NULL,
    input_hash character varying(64) NOT NULL,
    model character varying(160),
    prompt_version character varying(160),
    error text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    input_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: meeting_ambient_context_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_ambient_context_cursors (
    meeting_id uuid NOT NULL,
    last_processed_segment_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_through timestamp with time zone,
    detection_state character varying(16) DEFAULT 'idle'::character varying NOT NULL,
    detection_requested boolean DEFAULT false NOT NULL,
    CONSTRAINT meeting_ambient_context_cursors_detection_state_check CHECK (((detection_state)::text = ANY ((ARRAY['idle'::character varying, 'running'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: meeting_ambient_context_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_ambient_context_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    entity_kind character varying(24) NOT NULL,
    canonical_key character varying(320) NOT NULL,
    display_name character varying(255) NOT NULL,
    qualifier character varying(320),
    image_status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    image_storage_key text,
    image_mime_type character varying(96),
    professional_title character varying(255),
    company_name character varying(255),
    headquarters character varying(255),
    official_website text,
    profile_url text,
    summary text,
    facts jsonb DEFAULT '[]'::jsonb NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    facets jsonb DEFAULT '[]'::jsonb NOT NULL,
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    mention_count integer DEFAULT 1 NOT NULL,
    error text,
    first_mentioned_at timestamp with time zone DEFAULT now() NOT NULL,
    last_mentioned_at timestamp with time zone DEFAULT now() NOT NULL,
    research_started_at timestamp with time zone,
    research_completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mention_segment_ids jsonb,
    CONSTRAINT meeting_ambient_context_items_entity_kind_check CHECK (((entity_kind)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying])::text[]))),
    CONSTRAINT meeting_ambient_context_items_image_status_check CHECK (((image_status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'unavailable'::character varying])::text[]))),
    CONSTRAINT meeting_ambient_context_items_mention_count_check CHECK ((mention_count > 0)),
    CONSTRAINT meeting_ambient_context_items_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'researching'::character varying, 'ready'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: meeting_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    kind character varying(32) DEFAULT 'screen_capture'::character varying NOT NULL,
    storage_key text NOT NULL,
    content_hash character varying(64) NOT NULL,
    mime_type character varying(64) NOT NULL,
    byte_size integer NOT NULL,
    width integer,
    height integer,
    captured_at timestamp with time zone NOT NULL,
    participant_identity text,
    track_sid text,
    trigger character varying(64) NOT NULL,
    transcript_segment_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    transcript_excerpt text,
    speaker_name character varying(120),
    include_in_linear boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meeting_attendance_intervals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_attendance_intervals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    left_at timestamp with time zone,
    CONSTRAINT meeting_attendance_intervals_check CHECK (((left_at IS NULL) OR (left_at >= joined_at)))
);


--
-- Name: meeting_attendee_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_attendee_workspaces (
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    assignment text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_attendee_workspaces_assignment_check CHECK ((assignment = ANY (ARRAY['host_workspace'::text, 'joined_workspace'::text, 'historical_default'::text])))
);


--
-- Name: meeting_capability_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_capability_recommendations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    extraction_id uuid NOT NULL,
    capability_key character varying(160) NOT NULL,
    rank integer NOT NULL,
    raw_score integer NOT NULL,
    final_score integer NOT NULL,
    signals_matched jsonb DEFAULT '[]'::jsonb NOT NULL,
    signals_missing jsonb DEFAULT '[]'::jsonb NOT NULL,
    exclusion_signals_checked jsonb DEFAULT '[]'::jsonb CONSTRAINT meeting_capability_recommend_exclusion_signals_checked_not_null NOT NULL,
    reasoning text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence text NOT NULL,
    selection_prompt_version character varying(32) CONSTRAINT meeting_capability_recommenda_selection_prompt_version_not_null NOT NULL,
    selection_model character varying(160) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meeting_extractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_extractions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    meeting_type text,
    meeting_type_confidence text,
    meeting_type_reasoning text,
    participants jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary_short text,
    summary_bullets jsonb DEFAULT '[]'::jsonb NOT NULL,
    decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    action_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    open_questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    key_topics jsonb DEFAULT '[]'::jsonb NOT NULL,
    signals jsonb DEFAULT '[]'::jsonb NOT NULL,
    failed_tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    extraction_model character varying(160) NOT NULL,
    extraction_prompt_version character varying(32) NOT NULL,
    transcript_hash character varying(128) NOT NULL,
    duration_ms integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    highlights jsonb DEFAULT '[]'::jsonb NOT NULL,
    content_status text DEFAULT 'pending'::text NOT NULL,
    signals_status text DEFAULT 'pending'::text NOT NULL
);


--
-- Name: meeting_join_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_join_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_link_id uuid NOT NULL,
    meeting_id uuid,
    user_id uuid NOT NULL,
    display_name_snapshot character varying(120) NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sip_call_id character varying(255),
    sip_participant_identity character varying(255),
    sip_holding_room character varying(255),
    active_join_key text GENERATED ALWAYS AS (
CASE
    WHEN (status = ANY (ARRAY['waiting'::text, 'admitted'::text])) THEN (((meeting_link_id)::text || ':'::text) || (user_id)::text)
    ELSE NULL::text
END) STORED
);


--
-- Name: meeting_link_call_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_link_call_ins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_link_id uuid NOT NULL,
    phone_number character varying(32) NOT NULL,
    pin character varying(16) NOT NULL,
    sip_dispatch_rule_id character varying(255),
    last_synced_meeting_id uuid,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_rule_kind character varying(16) DEFAULT 'direct'::character varying NOT NULL
);


--
-- Name: meeting_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(255) NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meeting_live_task_candidate_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_live_task_candidate_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    transcript_segment_id uuid,
    source_segment_id text,
    full_segment_text text NOT NULL,
    quote text NOT NULL,
    quote_start integer NOT NULL,
    quote_end integer NOT NULL,
    content_hash character varying(128) NOT NULL,
    speaker_identity text,
    speaker_user_id uuid,
    speaker_name character varying(160) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    sequence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_live_task_candidate_evidence_check CHECK ((quote_end > quote_start)),
    CONSTRAINT meeting_live_task_candidate_evidence_quote_start_check CHECK ((quote_start >= 0))
);


--
-- Name: meeting_live_task_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_live_task_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    linked_task_id uuid,
    state character varying(24) DEFAULT 'deferred'::character varying NOT NULL,
    title character varying(160) NOT NULL,
    description text,
    type text NOT NULL,
    work_kind text DEFAULT 'general'::text NOT NULL,
    owner_name character varying(120),
    owner_email character varying(255),
    owner_user_id uuid,
    owner_confidence text,
    due_date_value character varying(120),
    due_date_confidence text,
    confidence text NOT NULL,
    completion jsonb NOT NULL,
    source_quotes jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_reason text NOT NULL,
    unresolved_questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_evidence_at timestamp with time zone NOT NULL,
    action_confirmable_at timestamp with time zone,
    last_evidence_at timestamp with time zone NOT NULL,
    model character varying(160),
    prompt_version character varying(32),
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_live_task_candidates_state_check CHECK (((state)::text = ANY ((ARRAY['deferred'::character varying, 'confirmed'::character varying, 'rejected'::character varying, 'retracted'::character varying])::text[])))
);


--
-- Name: meeting_live_task_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_live_task_cursors (
    meeting_id uuid NOT NULL,
    last_processed_segment_id uuid,
    processed_through timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_task_offset integer DEFAULT 0 NOT NULL
);


--
-- Name: meeting_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'guest'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);


--
-- Name: meeting_research_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_research_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    recommendation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_profile_id uuid NOT NULL,
    query text NOT NULL,
    task_kind character varying(64) DEFAULT 'answer_question'::character varying NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    progress_label text,
    progress_detail text,
    progress_updated_at timestamp with time zone,
    run_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    active_recommendation_key text GENERATED ALWAYS AS (
CASE
    WHEN (status = ANY (ARRAY['queued'::text, 'running'::text])) THEN (((meeting_id)::text || ':'::text) || (recommendation_id)::text)
    ELSE NULL::text
END) STORED
);


--
-- Name: meeting_suggested_action_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_suggested_action_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    phase character varying(64) DEFAULT 'reading_notes'::character varying NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    message text,
    error text,
    selected_recommendation_ids jsonb DEFAULT '[]'::jsonb CONSTRAINT meeting_suggested_action_ru_selected_recommendation_id_not_null NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meeting_task_latency_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_task_latency_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_revision integer NOT NULL,
    kind character varying(24) NOT NULL,
    evidence_at timestamp with time zone NOT NULL,
    transcript_received_at timestamp with time zone,
    queue_started_at timestamp with time zone,
    model_completed_at timestamp with time zone,
    validation_committed_at timestamp with time zone DEFAULT now() CONSTRAINT meeting_task_latency_observati_validation_committed_at_not_null NOT NULL,
    outbox_published_at timestamp with time zone,
    realtime_received_at timestamp with time zone,
    refetch_started_at timestamp with time zone,
    refetch_completed_at timestamp with time zone,
    rendered_at timestamp with time zone,
    client_continuity character varying(16),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_task_latency_observations_client_continuity_check CHECK (((client_continuity)::text = ANY ((ARRAY['continuous'::character varying, 'recovered'::character varying])::text[]))),
    CONSTRAINT meeting_task_latency_observations_kind_check CHECK (((kind)::text = ANY ((ARRAY['appearance'::character varying, 'owner'::character varying, 'due_date'::character varying, 'completion'::character varying])::text[])))
);


--
-- Name: meeting_task_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_task_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    phase character varying(64),
    error jsonb,
    model character varying(160),
    prompt_version character varying(32),
    transcript_hash character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    task_list_version integer DEFAULT 1 NOT NULL
);


--
-- Name: meeting_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    task_list_id uuid NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    title character varying(160) NOT NULL,
    description text,
    type text NOT NULL,
    owner_name character varying(120),
    owner_email character varying(255),
    owner_confidence text,
    due_date_value character varying(120),
    due_date_confidence text,
    confidence text NOT NULL,
    source_quotes jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_from text DEFAULT 'meeting_transcript'::text NOT NULL,
    external_links jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    work_kind text DEFAULT 'general'::text NOT NULL,
    owner_user_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone,
    asset_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin character varying(16) DEFAULT 'final'::character varying NOT NULL,
    status_source character varying(16) DEFAULT 'model'::character varying NOT NULL,
    status_actor_user_id uuid,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    action_confirmable_at timestamp with time zone,
    detected_at timestamp with time zone,
    first_rendered_at timestamp with time zone,
    first_rendered_reported_at timestamp with time zone,
    realtime_received_at timestamp with time zone,
    refetch_started_at timestamp with time zone,
    refetch_completed_at timestamp with time zone,
    CONSTRAINT meeting_tasks_origin_check CHECK (((origin)::text = ANY ((ARRAY['live'::character varying, 'final'::character varying])::text[]))),
    CONSTRAINT meeting_tasks_status_source_check CHECK (((status_source)::text = ANY ((ARRAY['model'::character varying, 'user'::character varying])::text[])))
);


--
-- Name: meeting_trackers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_trackers (
    meeting_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    processed_segment_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone,
    status text DEFAULT 'idle'::text NOT NULL
);


--
-- Name: meeting_trial_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_trial_slots (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    meeting_id uuid,
    slot smallint NOT NULL,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_trial_slots_slot_check CHECK (((slot >= 1) AND (slot <= 3)))
);


--
-- Name: meeting_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    owner_participant_identity text NOT NULL,
    agent_profile_id uuid NOT NULL,
    assistant_display_name character varying(120) NOT NULL,
    voice_id character varying(120),
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_turn_key text GENERATED ALWAYS AS (
CASE
    WHEN ((status)::text = 'active'::text) THEN (meeting_id)::text
    ELSE NULL::text
END) STORED
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(255) NOT NULL,
    room_name character varying(255) NOT NULL,
    created_by_user_id uuid NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    hidden_from_history_at timestamp with time zone,
    hidden_from_history_reason text,
    workspace_id uuid NOT NULL,
    meeting_link_id uuid,
    instance_number integer DEFAULT 1 NOT NULL,
    kind character varying(32) DEFAULT 'standard'::character varying NOT NULL,
    is_confidential boolean DEFAULT true NOT NULL,
    confidentiality_source character varying(16),
    confidentiality_updated_by_user_id uuid,
    confidentiality_updated_at timestamp with time zone,
    agent_intro_key text GENERATED ALWAYS AS (
CASE
    WHEN (((kind)::text = 'agent_intro'::text) AND (hidden_from_history_reason IS DISTINCT FROM 'debug_onboarding_reset'::text)) THEN (created_by_user_id)::text
    ELSE NULL::text
END) STORED,
    current_link_key text GENERATED ALWAYS AS (
CASE
    WHEN ((meeting_link_id IS NOT NULL) AND (status = ANY (ARRAY['scheduled'::text, 'active'::text]))) THEN (meeting_link_id)::text
    ELSE NULL::text
END) STORED,
    CONSTRAINT meetings_confidentiality_source_check CHECK (((confidentiality_source IS NULL) OR ((confidentiality_source)::text = ANY ((ARRAY['auto'::character varying, 'manual'::character varying])::text[])))),
    CONSTRAINT meetings_kind_check CHECK (((kind)::text = ANY ((ARRAY['standard'::character varying, 'agent_intro'::character varying])::text[])))
);


--
-- Name: memory_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_evidence (
    memory_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    quote text NOT NULL
);


--
-- Name: memory_generation_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_generation_ledger (
    user_id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    job_id uuid NOT NULL,
    model_started_at timestamp with time zone,
    source_id uuid,
    source_revision text,
    preferences_revision integer,
    request_token uuid,
    completed_at timestamp with time zone,
    error text
);


--
-- Name: memory_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_interactions (
    source_id uuid NOT NULL,
    person_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL
);


--
-- Name: memory_legacy_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_legacy_suppressions (
    source_id uuid CONSTRAINT memory_suppressions_source_id_not_null NOT NULL,
    segment_id uuid CONSTRAINT memory_suppressions_segment_id_not_null NOT NULL
);


--
-- Name: memory_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL
);


--
-- Name: memory_person_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_person_identities (
    person_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    identity text NOT NULL,
    CONSTRAINT memory_person_identities_kind_check CHECK ((kind = ANY (ARRAY['user_id'::text, 'verified_email'::text, 'guest_browser'::text])))
);


--
-- Name: memory_person_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_person_names (
    person_id uuid NOT NULL,
    source_id uuid NOT NULL,
    participant_user_id uuid NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    word_count integer NOT NULL,
    observed_at timestamp with time zone NOT NULL
);


--
-- Name: memory_person_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_person_projections (
    person_id uuid NOT NULL,
    input_hash text NOT NULL,
    content jsonb NOT NULL,
    prompt_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_revisions jsonb
);


--
-- Name: memory_person_redirects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_person_redirects (
    person_id uuid NOT NULL,
    target_person_id uuid NOT NULL,
    CONSTRAINT memory_person_redirects_check CHECK ((person_id <> target_person_id))
);


--
-- Name: memory_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_preferences (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    include_sensitive boolean DEFAULT false NOT NULL,
    language text DEFAULT 'English'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL
);


--
-- Name: memory_runtime_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_runtime_policy (
    id boolean DEFAULT true NOT NULL,
    future_only_since timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT memory_runtime_policy_id_check CHECK (id)
);


--
-- Name: memory_sensitivity_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_sensitivity_history (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    include_sensitive boolean NOT NULL
);


--
-- Name: memory_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    meeting_id uuid,
    occurred_at timestamp with time zone NOT NULL,
    revision text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    include_sensitive boolean DEFAULT false NOT NULL
);


--
-- Name: memory_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_suppressions (
    source_id uuid CONSTRAINT memory_suppressions_source_id_not_null1 NOT NULL,
    fact_fingerprint text NOT NULL,
    fact_identity jsonb NOT NULL
);


--
-- Name: memory_sync_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_sync_changes (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    source_id uuid NOT NULL,
    version bigint NOT NULL
);


--
-- Name: memory_sync_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_sync_heads (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version bigint DEFAULT 0 NOT NULL
);


--
-- Name: pending_google_addon_calendar_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_google_addon_calendar_credentials (
    agent_connector_id uuid CONSTRAINT pending_google_addon_calendar_crede_agent_connector_id_not_null NOT NULL,
    secret_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_task_clearances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_task_clearances (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    completed_before timestamp with time zone NOT NULL
);


--
-- Name: personal_task_item_clearances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_task_item_clearances (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    source_task_id uuid NOT NULL,
    completed_before timestamp with time zone NOT NULL
);


--
-- Name: private_beta_waitlist_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_beta_waitlist_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: relationship_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationship_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    fingerprint text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    person_ids uuid[] NOT NULL,
    candidate_subject_id uuid,
    candidate_subject_key text,
    sensitive boolean NOT NULL,
    confidence text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    importance smallint DEFAULT 1 NOT NULL,
    fact_fingerprint text NOT NULL,
    fact_identity jsonb NOT NULL,
    evidence_occurred_at timestamp with time zone,
    CONSTRAINT relationship_memories_importance_check CHECK (((importance >= 1) AND (importance <= 4)))
);


--
-- Name: slack_delivery_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_delivery_configs (
    user_id uuid NOT NULL,
    routes jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_meeting_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_meeting_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    status character varying(32) NOT NULL,
    category character varying(64),
    channel_id text,
    channel_name text,
    skip_reason text,
    message_ts text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_meeting_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_meeting_reviews (
    id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    review jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_review_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_review_deliveries (
    review_id uuid NOT NULL,
    destination text NOT NULL,
    status text NOT NULL,
    message_ts text
);


--
-- Name: stripe_webhook_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_receipts (
    stripe_event_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    content text NOT NULL,
    model character varying(120) DEFAULT 'placeholder-v1'::character varying NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transcript_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transcript_id uuid NOT NULL,
    speaker_user_id uuid,
    speaker_name character varying(120) NOT NULL,
    content text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    speaker_identity text NOT NULL,
    speaker_role character varying(32) DEFAULT 'human'::character varying NOT NULL,
    source character varying(64) DEFAULT 'legacy-transcript'::character varying NOT NULL,
    source_segment_id text,
    meeting_turn_id uuid,
    agent_profile_id uuid,
    agent_owner_user_id uuid,
    voice_id character varying(120)
);


--
-- Name: transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    source character varying(64) DEFAULT 'livekit'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    meeting_id uuid,
    job_id uuid,
    workflow_run_id uuid,
    provider character varying(64) NOT NULL,
    category character varying(64) NOT NULL,
    model character varying(160),
    sku character varying(160),
    unit_count integer DEFAULT 0 NOT NULL,
    unit_type character varying(64) NOT NULL,
    unit_price_micro_usd integer,
    cost_micro_usd integer DEFAULT 0 NOT NULL,
    source character varying(120) NOT NULL,
    idempotency_key character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_acquisition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_acquisition (
    user_id uuid NOT NULL,
    workspace_id uuid,
    attribution jsonb NOT NULL,
    analytics_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_auth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_auth_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(64) NOT NULL,
    provider_account_id character varying(255),
    first_authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_count integer DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    null_account_key text GENERATED ALWAYS AS (
CASE
    WHEN (provider_account_id IS NULL) THEN (((user_id)::text || ':'::text) || (provider)::text)
    ELSE NULL::text
END) STORED
);


--
-- Name: user_capability_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_capability_preferences (
    user_id uuid NOT NULL,
    capability_key character varying(160) NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_media_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_media_preferences (
    user_id uuid NOT NULL,
    background_blur_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    display_name character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar_url character varying(1024),
    source text DEFAULT 'auth'::text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    has_completed_first_meeting boolean DEFAULT false NOT NULL,
    session_version integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    agent_intro_completed_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    active_workspace_id uuid,
    private_beta_pro_enabled_at timestamp with time zone,
    deletion_requested_at timestamp with time zone
);


--
-- Name: voice_web_research_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_web_research_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_profile_id uuid NOT NULL,
    utterance_id character varying(160) NOT NULL,
    query text NOT NULL,
    query_key character varying(260) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    research_mode character varying(48) DEFAULT 'fast_grounded'::character varying NOT NULL,
    session_id character varying(1000),
    search_id character varying(180),
    findall_id character varying(180),
    taskgroup_id character varying(180),
    run_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    error jsonb,
    cancelled_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_ashby_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_ashby_integrations (
    workspace_id uuid NOT NULL,
    secret_ref text NOT NULL,
    configured_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid,
    event_type character varying(64) NOT NULL,
    subject_type character varying(32),
    subject_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_billing_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_billing_customers (
    workspace_id uuid NOT NULL,
    stripe_customer_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    token_hash text NOT NULL,
    invited_by_user_id uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by_user_id uuid,
    revoked_at timestamp with time zone,
    last_sent_at timestamp with time zone DEFAULT now() NOT NULL,
    send_count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_email_key text GENERATED ALWAYS AS (
CASE
    WHEN ((accepted_at IS NULL) AND (revoked_at IS NULL)) THEN (((workspace_id)::text || ':'::text) || lower((email)::text))
    ELSE NULL::text
END) STORED,
    CONSTRAINT workspace_invitations_no_owner_role_chk CHECK ((role <> 'owner'::text))
);


--
-- Name: workspace_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    suspended_at timestamp with time zone,
    active_owner_key text GENERATED ALWAYS AS (
CASE
    WHEN ((role = 'owner'::text) AND (status = 'active'::text)) THEN (workspace_id)::text
    ELSE NULL::text
END) STORED,
    CONSTRAINT workspace_memberships_owner_must_be_active_chk CHECK (((role <> 'owner'::text) OR (status = 'active'::text)))
);


--
-- Name: workspace_task_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_task_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title character varying(120) NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: workspace_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    assignee_user_id uuid,
    title character varying(160) NOT NULL,
    description text,
    due_date_value character varying(120),
    due_date_confidence text,
    status text DEFAULT 'open'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    logo_url text,
    plan text DEFAULT 'free'::text NOT NULL,
    created_via character varying(24) DEFAULT 'user'::character varying NOT NULL
);


--
-- Name: acquisition_payments acquisition_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acquisition_payments
    ADD CONSTRAINT acquisition_payments_pkey PRIMARY KEY (transaction_id);


--
-- Name: action_items action_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_items
    ADD CONSTRAINT action_items_pkey PRIMARY KEY (id);


--
-- Name: admin_user_plan_changes admin_user_plan_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_user_plan_changes
    ADD CONSTRAINT admin_user_plan_changes_pkey PRIMARY KEY (id);


--
-- Name: agent_connector_secrets agent_connector_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connector_secrets
    ADD CONSTRAINT agent_connector_secrets_pkey PRIMARY KEY (id);


--
-- Name: agent_connectors agent_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connectors
    ADD CONSTRAINT agent_connectors_pkey PRIMARY KEY (id);


--
-- Name: agent_memories agent_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_pkey PRIMARY KEY (id);


--
-- Name: agent_profiles agent_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_invocations agent_tool_invocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_policies agent_tool_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_policies
    ADD CONSTRAINT agent_tool_policies_pkey PRIMARY KEY (id);


--
-- Name: ai_credit_pricing_config ai_credit_pricing_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_pricing_config
    ADD CONSTRAINT ai_credit_pricing_config_pkey PRIMARY KEY (id);


--
-- Name: ai_credit_usage_events ai_credit_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_pkey PRIMARY KEY (id);


--
-- Name: ai_workflow_executions ai_workflow_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workflow_executions
    ADD CONSTRAINT ai_workflow_executions_pkey PRIMARY KEY (id);


--
-- Name: ashby_candidate_email_lookups ashby_candidate_email_lookups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_candidate_email_lookups
    ADD CONSTRAINT ashby_candidate_email_lookups_pkey PRIMARY KEY (workspace_id, email);


--
-- Name: ashby_meeting_analyses ashby_meeting_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_meeting_analyses
    ADD CONSTRAINT ashby_meeting_analyses_pkey PRIMARY KEY (meeting_id, input_hash);


--
-- Name: ashby_member_connections ashby_member_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_member_connections
    ADD CONSTRAINT ashby_member_connections_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: ashby_review_actions ashby_review_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_review_actions
    ADD CONSTRAINT ashby_review_actions_pkey PRIMARY KEY (id);


--
-- Name: ashby_review_actions ashby_review_actions_stage_only; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.ashby_review_actions
    ADD CONSTRAINT ashby_review_actions_stage_only CHECK ((kind = 'stage'::text)) NOT VALID;


--
-- Name: ashby_review_actions ashby_review_actions_workspace_id_meeting_id_kind_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_review_actions
    ADD CONSTRAINT ashby_review_actions_workspace_id_meeting_id_kind_target_id_key UNIQUE (workspace_id, meeting_id, kind, target_id);


--
-- Name: ashby_reviews ashby_reviews_meeting_id_user_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_reviews
    ADD CONSTRAINT ashby_reviews_meeting_id_user_id_workspace_id_key UNIQUE (meeting_id, user_id, workspace_id);


--
-- Name: ashby_reviews ashby_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_reviews
    ADD CONSTRAINT ashby_reviews_pkey PRIMARY KEY (id);


--
-- Name: assigned_task_placements assigned_task_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assigned_task_placements
    ADD CONSTRAINT assigned_task_placements_pkey PRIMARY KEY (source_type, source_task_id, workspace_id, assignee_user_id);


--
-- Name: billing_checkout_attempts billing_checkout_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_attempts
    ADD CONSTRAINT billing_checkout_attempts_pkey PRIMARY KEY (id);


--
-- Name: billing_checkout_attempts billing_checkout_attempts_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_attempts
    ADD CONSTRAINT billing_checkout_attempts_request_key_key UNIQUE (request_key);


--
-- Name: billing_checkout_attempts billing_checkout_attempts_stripe_checkout_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkout_attempts
    ADD CONSTRAINT billing_checkout_attempts_stripe_checkout_session_id_key UNIQUE (stripe_checkout_session_id);


--
-- Name: billing_customers billing_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_pkey PRIMARY KEY (user_id);


--
-- Name: billing_customers billing_customers_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: billing_subscriptions billing_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: billing_subscriptions billing_subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: calendar_event_preps calendar_event_preps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_preps
    ADD CONSTRAINT calendar_event_preps_pkey PRIMARY KEY (id);


--
-- Name: calendar_ready_links calendar_ready_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_ready_links
    ADD CONSTRAINT calendar_ready_links_pkey PRIMARY KEY (id);


--
-- Name: calendar_ready_links calendar_ready_links_user_id_calendar_account_id_provider_c_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_ready_links
    ADD CONSTRAINT calendar_ready_links_user_id_calendar_account_id_provider_c_key UNIQUE (user_id, calendar_account_id, provider, calendar_id, provider_event_id);


--
-- Name: calendar_sync_subscriptions calendar_sync_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_subscriptions
    ADD CONSTRAINT calendar_sync_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: capability_catalog capability_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_catalog
    ADD CONSTRAINT capability_catalog_pkey PRIMARY KEY (id);


--
-- Name: capability_workflow_messages capability_workflow_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_messages
    ADD CONSTRAINT capability_workflow_messages_pkey PRIMARY KEY (id);


--
-- Name: capability_workflow_runs capability_workflow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_runs
    ADD CONSTRAINT capability_workflow_runs_pkey PRIMARY KEY (id);


--
-- Name: credit_grants credit_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_grants
    ADD CONSTRAINT credit_grants_pkey PRIMARY KEY (id);


--
-- Name: data_deletion_requests data_deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: google_addon_conferences google_addon_conferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_addon_conferences
    ADD CONSTRAINT google_addon_conferences_pkey PRIMARY KEY (id);


--
-- Name: guest_auth_sessions guest_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: guest_browser_identities guest_browser_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_identities
    ADD CONSTRAINT guest_browser_identities_pkey PRIMARY KEY (id);


--
-- Name: guest_browser_identities guest_browser_identities_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_identities
    ADD CONSTRAINT guest_browser_identities_token_hash_key UNIQUE (token_hash);


--
-- Name: guest_browser_users guest_browser_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_users
    ADD CONSTRAINT guest_browser_users_pkey PRIMARY KEY (guest_user_id);


--
-- Name: guest_memory_account_links guest_memory_account_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_memory_account_links
    ADD CONSTRAINT guest_memory_account_links_pkey PRIMARY KEY (guest_user_id);


--
-- Name: linear_task_review_items linear_task_review_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_items
    ADD CONSTRAINT linear_task_review_items_pkey PRIMARY KEY (id);


--
-- Name: linear_task_review_runs linear_task_review_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_runs
    ADD CONSTRAINT linear_task_review_runs_pkey PRIMARY KEY (id);


--
-- Name: meeting_ambient_context_cursors meeting_ambient_context_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_cursors
    ADD CONSTRAINT meeting_ambient_context_cursors_pkey PRIMARY KEY (meeting_id);


--
-- Name: meeting_ambient_context_items meeting_ambient_context_items_identity_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_items
    ADD CONSTRAINT meeting_ambient_context_items_identity_uidx UNIQUE (meeting_id, canonical_key);


--
-- Name: meeting_ambient_context_items meeting_ambient_context_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_items
    ADD CONSTRAINT meeting_ambient_context_items_pkey PRIMARY KEY (id);


--
-- Name: meeting_assets meeting_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_assets
    ADD CONSTRAINT meeting_assets_pkey PRIMARY KEY (id);


--
-- Name: meeting_assets meeting_assets_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_assets
    ADD CONSTRAINT meeting_assets_storage_key_key UNIQUE (storage_key);


--
-- Name: meeting_attendance_intervals meeting_attendance_intervals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendance_intervals
    ADD CONSTRAINT meeting_attendance_intervals_pkey PRIMARY KEY (id);


--
-- Name: meeting_attendee_workspaces meeting_attendee_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendee_workspaces
    ADD CONSTRAINT meeting_attendee_workspaces_pkey PRIMARY KEY (meeting_id, user_id);


--
-- Name: meeting_capability_recommendations meeting_capability_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_capability_recommendations
    ADD CONSTRAINT meeting_capability_recommendations_pkey PRIMARY KEY (id);


--
-- Name: meeting_extractions meeting_extractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_extractions
    ADD CONSTRAINT meeting_extractions_pkey PRIMARY KEY (id);


--
-- Name: meeting_join_requests meeting_join_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_join_requests
    ADD CONSTRAINT meeting_join_requests_pkey PRIMARY KEY (id);


--
-- Name: meeting_link_call_ins meeting_link_call_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_link_call_ins
    ADD CONSTRAINT meeting_link_call_ins_pkey PRIMARY KEY (id);


--
-- Name: meeting_links meeting_links_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_links
    ADD CONSTRAINT meeting_links_code_key UNIQUE (code);


--
-- Name: meeting_links meeting_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_links
    ADD CONSTRAINT meeting_links_pkey PRIMARY KEY (id);


--
-- Name: meeting_live_task_candidate_evidence meeting_live_task_candidate_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidate_evidence
    ADD CONSTRAINT meeting_live_task_candidate_evidence_pkey PRIMARY KEY (id);


--
-- Name: meeting_live_task_candidates meeting_live_task_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidates
    ADD CONSTRAINT meeting_live_task_candidates_pkey PRIMARY KEY (id);


--
-- Name: meeting_live_task_cursors meeting_live_task_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_cursors
    ADD CONSTRAINT meeting_live_task_cursors_pkey PRIMARY KEY (meeting_id);


--
-- Name: meeting_participants meeting_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_participants
    ADD CONSTRAINT meeting_participants_pkey PRIMARY KEY (id);


--
-- Name: meeting_research_runs meeting_research_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_research_runs
    ADD CONSTRAINT meeting_research_runs_pkey PRIMARY KEY (id);


--
-- Name: meeting_suggested_action_runs meeting_suggested_action_runs_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_suggested_action_runs
    ADD CONSTRAINT meeting_suggested_action_runs_meeting_id_key UNIQUE (meeting_id);


--
-- Name: meeting_suggested_action_runs meeting_suggested_action_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_suggested_action_runs
    ADD CONSTRAINT meeting_suggested_action_runs_pkey PRIMARY KEY (id);


--
-- Name: meeting_task_latency_observations meeting_task_latency_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_latency_observations
    ADD CONSTRAINT meeting_task_latency_observations_pkey PRIMARY KEY (id);


--
-- Name: meeting_task_lists meeting_task_lists_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_lists
    ADD CONSTRAINT meeting_task_lists_meeting_id_key UNIQUE (meeting_id);


--
-- Name: meeting_task_lists meeting_task_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_lists
    ADD CONSTRAINT meeting_task_lists_pkey PRIMARY KEY (id);


--
-- Name: meeting_tasks meeting_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_tasks
    ADD CONSTRAINT meeting_tasks_pkey PRIMARY KEY (id);


--
-- Name: meeting_trackers meeting_trackers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trackers
    ADD CONSTRAINT meeting_trackers_pkey PRIMARY KEY (meeting_id);


--
-- Name: meeting_trial_slots meeting_trial_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trial_slots
    ADD CONSTRAINT meeting_trial_slots_pkey PRIMARY KEY (user_id, workspace_id, slot);


--
-- Name: meeting_trial_slots meeting_trial_slots_user_id_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trial_slots
    ADD CONSTRAINT meeting_trial_slots_user_id_meeting_id_key UNIQUE (user_id, meeting_id);


--
-- Name: meeting_turns meeting_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_turns
    ADD CONSTRAINT meeting_turns_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_id_workspace_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_id_workspace_unique UNIQUE (id, workspace_id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_room_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_room_name_key UNIQUE (room_name);


--
-- Name: memory_evidence memory_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_evidence
    ADD CONSTRAINT memory_evidence_pkey PRIMARY KEY (memory_id, segment_id);


--
-- Name: memory_generation_ledger memory_generation_ledger_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_generation_ledger
    ADD CONSTRAINT memory_generation_ledger_job_id_key UNIQUE (job_id);


--
-- Name: memory_generation_ledger memory_generation_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_generation_ledger
    ADD CONSTRAINT memory_generation_ledger_pkey PRIMARY KEY (user_id, meeting_id);


--
-- Name: memory_interactions memory_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_interactions
    ADD CONSTRAINT memory_interactions_pkey PRIMARY KEY (source_id, person_id);


--
-- Name: memory_people memory_people_id_user_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_people
    ADD CONSTRAINT memory_people_id_user_id_workspace_id_key UNIQUE (id, user_id, workspace_id);


--
-- Name: memory_people memory_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_people
    ADD CONSTRAINT memory_people_pkey PRIMARY KEY (id);


--
-- Name: memory_person_identities memory_person_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_identities
    ADD CONSTRAINT memory_person_identities_pkey PRIMARY KEY (user_id, workspace_id, kind, identity);


--
-- Name: memory_person_names memory_person_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_names
    ADD CONSTRAINT memory_person_names_pkey PRIMARY KEY (person_id, source_id, participant_user_id);


--
-- Name: memory_person_projections memory_person_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_projections
    ADD CONSTRAINT memory_person_projections_pkey PRIMARY KEY (person_id);


--
-- Name: memory_person_redirects memory_person_redirects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_redirects
    ADD CONSTRAINT memory_person_redirects_pkey PRIMARY KEY (person_id);


--
-- Name: memory_preferences memory_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_preferences
    ADD CONSTRAINT memory_preferences_pkey PRIMARY KEY (user_id, workspace_id);


--
-- Name: memory_runtime_policy memory_runtime_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_runtime_policy
    ADD CONSTRAINT memory_runtime_policy_pkey PRIMARY KEY (id);


--
-- Name: memory_sensitivity_history memory_sensitivity_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sensitivity_history
    ADD CONSTRAINT memory_sensitivity_history_pkey PRIMARY KEY (user_id, workspace_id, effective_at);


--
-- Name: memory_sources memory_sources_id_user_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_id_user_id_workspace_id_key UNIQUE (id, user_id, workspace_id);


--
-- Name: memory_sources memory_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_pkey PRIMARY KEY (id);


--
-- Name: memory_sources memory_sources_user_id_workspace_id_kind_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_user_id_workspace_id_kind_external_id_key UNIQUE (user_id, workspace_id, kind, external_id);


--
-- Name: memory_legacy_suppressions memory_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_legacy_suppressions
    ADD CONSTRAINT memory_suppressions_pkey PRIMARY KEY (source_id, segment_id);


--
-- Name: memory_suppressions memory_suppressions_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_suppressions
    ADD CONSTRAINT memory_suppressions_pkey1 PRIMARY KEY (source_id, fact_fingerprint);


--
-- Name: memory_sync_changes memory_sync_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sync_changes
    ADD CONSTRAINT memory_sync_changes_pkey PRIMARY KEY (user_id, workspace_id, memory_id);


--
-- Name: memory_sync_heads memory_sync_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sync_heads
    ADD CONSTRAINT memory_sync_heads_pkey PRIMARY KEY (user_id, workspace_id);


--
-- Name: pending_google_addon_calendar_credentials pending_google_addon_calendar_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_google_addon_calendar_credentials
    ADD CONSTRAINT pending_google_addon_calendar_credentials_pkey PRIMARY KEY (agent_connector_id);


--
-- Name: personal_task_clearances personal_task_clearances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_clearances
    ADD CONSTRAINT personal_task_clearances_pkey PRIMARY KEY (user_id, workspace_id);


--
-- Name: personal_task_item_clearances personal_task_item_clearances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_item_clearances
    ADD CONSTRAINT personal_task_item_clearances_pkey PRIMARY KEY (user_id, workspace_id, source_type, source_task_id);


--
-- Name: private_beta_waitlist_entries private_beta_waitlist_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_beta_waitlist_entries
    ADD CONSTRAINT private_beta_waitlist_entries_pkey PRIMARY KEY (id);


--
-- Name: relationship_memories relationship_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_memories
    ADD CONSTRAINT relationship_memories_pkey PRIMARY KEY (id);


--
-- Name: relationship_memories relationship_memories_source_id_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_memories
    ADD CONSTRAINT relationship_memories_source_id_fingerprint_key UNIQUE (source_id, fingerprint);


--
-- Name: slack_delivery_configs slack_delivery_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_delivery_configs
    ADD CONSTRAINT slack_delivery_configs_pkey PRIMARY KEY (user_id);


--
-- Name: slack_meeting_deliveries slack_meeting_deliveries_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_deliveries
    ADD CONSTRAINT slack_meeting_deliveries_meeting_id_key UNIQUE (meeting_id);


--
-- Name: slack_meeting_deliveries slack_meeting_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_deliveries
    ADD CONSTRAINT slack_meeting_deliveries_pkey PRIMARY KEY (id);


--
-- Name: slack_meeting_reviews slack_meeting_reviews_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_reviews
    ADD CONSTRAINT slack_meeting_reviews_meeting_id_key UNIQUE (meeting_id);


--
-- Name: slack_meeting_reviews slack_meeting_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_reviews
    ADD CONSTRAINT slack_meeting_reviews_pkey PRIMARY KEY (id);


--
-- Name: slack_review_deliveries slack_review_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_review_deliveries
    ADD CONSTRAINT slack_review_deliveries_pkey PRIMARY KEY (review_id, destination);


--
-- Name: stripe_webhook_receipts stripe_webhook_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_receipts
    ADD CONSTRAINT stripe_webhook_receipts_pkey PRIMARY KEY (stripe_event_id);


--
-- Name: summaries summaries_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summaries
    ADD CONSTRAINT summaries_meeting_id_key UNIQUE (meeting_id);


--
-- Name: summaries summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summaries
    ADD CONSTRAINT summaries_pkey PRIMARY KEY (id);


--
-- Name: transcript_segments transcript_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_pkey PRIMARY KEY (id);


--
-- Name: transcripts transcripts_meeting_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_meeting_id_key UNIQUE (meeting_id);


--
-- Name: transcripts transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);


--
-- Name: user_acquisition user_acquisition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_acquisition
    ADD CONSTRAINT user_acquisition_pkey PRIMARY KEY (user_id);


--
-- Name: user_auth_accounts user_auth_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_auth_accounts
    ADD CONSTRAINT user_auth_accounts_pkey PRIMARY KEY (id);


--
-- Name: user_media_preferences user_media_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_preferences
    ADD CONSTRAINT user_media_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: voice_web_research_runs voice_web_research_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_web_research_runs
    ADD CONSTRAINT voice_web_research_runs_pkey PRIMARY KEY (id);


--
-- Name: workspace_ashby_integrations workspace_ashby_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_ashby_integrations
    ADD CONSTRAINT workspace_ashby_integrations_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_audit_events workspace_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_audit_events
    ADD CONSTRAINT workspace_audit_events_pkey PRIMARY KEY (id);


--
-- Name: workspace_billing_customers workspace_billing_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_billing_customers
    ADD CONSTRAINT workspace_billing_customers_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_billing_customers workspace_billing_customers_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_billing_customers
    ADD CONSTRAINT workspace_billing_customers_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: workspace_invitations workspace_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);


--
-- Name: workspace_memberships workspace_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (id);


--
-- Name: workspace_task_sections workspace_task_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_task_sections
    ADD CONSTRAINT workspace_task_sections_pkey PRIMARY KEY (id);


--
-- Name: workspace_tasks workspace_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tasks
    ADD CONSTRAINT workspace_tasks_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: agent_connectors_active_account_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_connectors_active_account_key_uidx ON public.agent_connectors USING btree (active_account_key);


--
-- Name: agent_connectors_null_account_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_connectors_null_account_key_uidx ON public.agent_connectors USING btree (null_account_key);


--
-- Name: agent_profiles_default_profile_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_profiles_default_profile_key_uidx ON public.agent_profiles USING btree (default_profile_key);


--
-- Name: agent_tool_invocations_idempotency_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_tool_invocations_idempotency_uidx ON public.agent_tool_invocations USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: agent_tool_policies_profile_tool_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_tool_policies_profile_tool_uidx ON public.agent_tool_policies USING btree (agent_profile_id, tool_name);


--
-- Name: ai_credit_usage_events_idempotency_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_credit_usage_events_idempotency_key_uidx ON public.ai_credit_usage_events USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: ai_credit_usage_events_user_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_credit_usage_events_user_workspace_created_idx ON public.ai_credit_usage_events USING btree (user_id, workspace_id, created_at);


--
-- Name: ai_workflow_executions_preview_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_workflow_executions_preview_key_uidx ON public.ai_workflow_executions USING btree (preview_key);


--
-- Name: attendance_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX attendance_one_open ON public.meeting_attendance_intervals USING btree (meeting_id, user_id) WHERE (left_at IS NULL);


--
-- Name: billing_checkout_attempts_pending_checkout_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_checkout_attempts_pending_checkout_key_uidx ON public.billing_checkout_attempts USING btree (pending_checkout_key);


--
-- Name: billing_subscriptions_running_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_subscriptions_running_user_uidx ON public.billing_subscriptions USING btree (user_id) WHERE ((workspace_id IS NULL) AND ((status)::text = ANY ((ARRAY['active'::character varying, 'trialing'::character varying])::text[])));


--
-- Name: billing_subscriptions_running_workspace_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_subscriptions_running_workspace_uidx ON public.billing_subscriptions USING btree (workspace_id) WHERE ((workspace_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['active'::character varying, 'trialing'::character varying])::text[])));


--
-- Name: calendar_event_preps_legacy_fingerprint_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_event_preps_legacy_fingerprint_key_uidx ON public.calendar_event_preps USING btree (legacy_fingerprint_key);


--
-- Name: calendar_event_preps_user_event_fingerprint_account_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_event_preps_user_event_fingerprint_account_uidx ON public.calendar_event_preps USING btree (user_id, calendar_event_id, event_fingerprint, calendar_account_id) WHERE (calendar_account_id IS NOT NULL);


--
-- Name: calendar_sync_subscriptions_active_calendar_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_sync_subscriptions_active_calendar_key_uidx ON public.calendar_sync_subscriptions USING btree (active_calendar_key);


--
-- Name: capability_catalog_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX capability_catalog_key_uidx ON public.capability_catalog USING btree (key);


--
-- Name: capability_workflow_runs_recommendation_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX capability_workflow_runs_recommendation_uidx ON public.capability_workflow_runs USING btree (recommendation_id);


--
-- Name: credit_grants_stripe_reference_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_grants_stripe_reference_uidx ON public.credit_grants USING btree (stripe_reference) WHERE (stripe_reference IS NOT NULL);


--
-- Name: google_addon_conferences_user_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX google_addon_conferences_user_key_uidx ON public.google_addon_conferences USING btree (user_id, idempotency_key);


--
-- Name: linear_task_review_items_run_position_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX linear_task_review_items_run_position_uidx ON public.linear_task_review_items USING btree (run_id, "position");


--
-- Name: linear_task_review_runs_meeting_input_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX linear_task_review_runs_meeting_input_uidx ON public.linear_task_review_runs USING btree (meeting_id, input_hash);


--
-- Name: meeting_assets_meeting_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_assets_meeting_hash_uidx ON public.meeting_assets USING btree (meeting_id, content_hash);


--
-- Name: meeting_capability_recommendations_extraction_capability_prompt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_capability_recommendations_extraction_capability_prompt ON public.meeting_capability_recommendations USING btree (extraction_id, capability_key, selection_prompt_version);


--
-- Name: meeting_extractions_meeting_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_extractions_meeting_uidx ON public.meeting_extractions USING btree (meeting_id);


--
-- Name: meeting_join_requests_active_join_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_join_requests_active_join_key_uidx ON public.meeting_join_requests USING btree (active_join_key);


--
-- Name: meeting_join_requests_sip_call_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_join_requests_sip_call_uidx ON public.meeting_join_requests USING btree (sip_call_id) WHERE (sip_call_id IS NOT NULL);


--
-- Name: meeting_link_call_ins_meeting_link_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_link_call_ins_meeting_link_uidx ON public.meeting_link_call_ins USING btree (meeting_link_id);


--
-- Name: meeting_link_call_ins_phone_pin_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_link_call_ins_phone_pin_uidx ON public.meeting_link_call_ins USING btree (phone_number, pin);


--
-- Name: meeting_research_runs_active_recommendation_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_research_runs_active_recommendation_key_uidx ON public.meeting_research_runs USING btree (active_recommendation_key);


--
-- Name: meeting_task_latency_observations_revision_kind_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_task_latency_observations_revision_kind_uidx ON public.meeting_task_latency_observations USING btree (task_id, task_revision, kind);


--
-- Name: meeting_turns_active_turn_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meeting_turns_active_turn_key_uidx ON public.meeting_turns USING btree (active_turn_key);


--
-- Name: meetings_agent_intro_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meetings_agent_intro_key_uidx ON public.meetings USING btree (agent_intro_key);


--
-- Name: meetings_current_link_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX meetings_current_link_key_uidx ON public.meetings USING btree (current_link_key);


--
-- Name: private_beta_waitlist_entries_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX private_beta_waitlist_entries_user_uidx ON public.private_beta_waitlist_entries USING btree (user_id);


--
-- Name: transcript_segments_source_segment_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_segments_source_segment_uidx ON public.transcript_segments USING btree (transcript_id, source, source_segment_id) WHERE (source_segment_id IS NOT NULL);


--
-- Name: transcripts_meeting_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcripts_meeting_unique_idx ON public.transcripts USING btree (meeting_id);


--
-- Name: usage_events_idempotency_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX usage_events_idempotency_key_uidx ON public.usage_events USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: user_auth_accounts_null_account_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_auth_accounts_null_account_key_uidx ON public.user_auth_accounts USING btree (null_account_key);


--
-- Name: user_auth_accounts_provider_account_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_auth_accounts_provider_account_uidx ON public.user_auth_accounts USING btree (provider, provider_account_id) WHERE (provider_account_id IS NOT NULL);


--
-- Name: user_capability_preferences_user_capability_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_capability_preferences_user_capability_uidx ON public.user_capability_preferences USING btree (user_id, capability_key);


--
-- Name: voice_web_research_runs_active_query_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voice_web_research_runs_active_query_uidx ON public.voice_web_research_runs USING btree (meeting_id, user_id, query_key) WHERE ((status)::text <> ALL ((ARRAY['failed'::character varying, 'cancelled'::character varying, 'expired'::character varying, 'completed'::character varying])::text[]));


--
-- Name: workspace_invitations_active_email_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_invitations_active_email_key_uidx ON public.workspace_invitations USING btree (active_email_key);


--
-- Name: workspace_invitations_token_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_invitations_token_hash_uidx ON public.workspace_invitations USING btree (token_hash);


--
-- Name: workspace_memberships_active_owner_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_memberships_active_owner_key_uidx ON public.workspace_memberships USING btree (active_owner_key);


--
-- Name: workspace_memberships_workspace_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_memberships_workspace_user_uidx ON public.workspace_memberships USING btree (workspace_id, user_id);


--
-- Name: workspace_task_sections_default_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_task_sections_default_uidx ON public.workspace_task_sections USING btree (workspace_id) WHERE ((is_default = true) AND (deleted_at IS NULL));


--
-- Name: workspace_task_sections_title_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_task_sections_title_uidx ON public.workspace_task_sections USING btree (workspace_id, title) WHERE (deleted_at IS NULL);


--
-- Name: workspaces_one_system_default_per_creator_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_one_system_default_per_creator_uidx ON public.workspaces USING btree (created_by_user_id) WHERE ((created_via)::text = 'system_default'::text);


--
-- Name: summaries allocate_completed_meeting_trial_slot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER allocate_completed_meeting_trial_slot AFTER INSERT OR UPDATE ON public.summaries FOR EACH ROW EXECUTE FUNCTION public.allocate_completed_meeting_trial_slot();


--
-- Name: relationship_memories canonicalize_memory_people; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER canonicalize_memory_people BEFORE INSERT OR UPDATE ON public.relationship_memories FOR EACH ROW EXECUTE FUNCTION public.canonicalize_memory_people_write();


--
-- Name: meeting_attendance_intervals capture_attendee_workspace; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_attendee_workspace AFTER INSERT ON public.meeting_attendance_intervals FOR EACH ROW EXECUTE FUNCTION public.capture_attendee_workspace();


--
-- Name: ai_credit_usage_events debit_ai_usage_credits; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debit_ai_usage_credits AFTER INSERT ON public.ai_credit_usage_events FOR EACH ROW EXECUTE FUNCTION public.debit_ai_usage_credits();


--
-- Name: meeting_participants memory_attendance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_attendance AFTER INSERT OR UPDATE ON public.meeting_participants FOR EACH ROW EXECUTE FUNCTION public.record_memory_attendance();


--
-- Name: memory_sources memory_attendee_workspace_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_attendee_workspace_boundary BEFORE INSERT OR UPDATE OF meeting_id, user_id, workspace_id ON public.memory_sources FOR EACH ROW EXECUTE FUNCTION public.enforce_memory_attendee_workspace();


--
-- Name: memory_preferences memory_sensitivity_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sensitivity_policy AFTER INSERT OR UPDATE OF include_sensitive ON public.memory_preferences FOR EACH ROW EXECUTE FUNCTION public.record_memory_sensitivity();


--
-- Name: memory_evidence memory_sync_evidence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sync_evidence AFTER INSERT OR DELETE OR UPDATE ON public.memory_evidence FOR EACH ROW EXECUTE FUNCTION public.track_memory_sync_evidence();


--
-- Name: relationship_memories memory_sync_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sync_row AFTER INSERT OR DELETE OR UPDATE ON public.relationship_memories FOR EACH ROW EXECUTE FUNCTION public.track_memory_sync_row();


--
-- Name: memory_sources memory_sync_source; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sync_source AFTER UPDATE OF is_current, include_sensitive ON public.memory_sources FOR EACH ROW EXECUTE FUNCTION public.track_memory_sync_source();


--
-- Name: memory_sources memory_sync_source_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sync_source_delete BEFORE DELETE ON public.memory_sources FOR EACH ROW EXECUTE FUNCTION public.track_memory_sync_source_delete();


--
-- Name: transcripts memory_transcript_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_transcript_parent BEFORE DELETE ON public.transcripts FOR EACH ROW EXECUTE FUNCTION public.invalidate_memory_transcript_parent();


--
-- Name: transcript_segments memory_transcript_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_transcript_revision AFTER INSERT OR DELETE OR UPDATE ON public.transcript_segments FOR EACH ROW EXECUTE FUNCTION public.invalidate_meeting_memories();


--
-- Name: memory_person_projections prevent_redirected_projection; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_redirected_projection BEFORE INSERT OR UPDATE ON public.memory_person_projections FOR EACH ROW EXECUTE FUNCTION public.prevent_redirected_memory_projection();


--
-- Name: meeting_attendee_workspaces remove_attendee_workspace_memory; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remove_attendee_workspace_memory AFTER DELETE ON public.meeting_attendee_workspaces FOR EACH ROW EXECUTE FUNCTION public.remove_attendee_workspace_memory();


--
-- Name: acquisition_payments acquisition_payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acquisition_payments
    ADD CONSTRAINT acquisition_payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: acquisition_payments acquisition_payments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acquisition_payments
    ADD CONSTRAINT acquisition_payments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: action_items action_items_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_items
    ADD CONSTRAINT action_items_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: admin_user_plan_changes admin_user_plan_changes_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_user_plan_changes
    ADD CONSTRAINT admin_user_plan_changes_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: admin_user_plan_changes admin_user_plan_changes_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_user_plan_changes
    ADD CONSTRAINT admin_user_plan_changes_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_connector_secrets agent_connector_secrets_agent_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connector_secrets
    ADD CONSTRAINT agent_connector_secrets_agent_connector_id_fkey FOREIGN KEY (agent_connector_id) REFERENCES public.agent_connectors(id) ON DELETE CASCADE;


--
-- Name: agent_connectors agent_connectors_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connectors
    ADD CONSTRAINT agent_connectors_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: agent_connectors agent_connectors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_connectors
    ADD CONSTRAINT agent_connectors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_memories agent_memories_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: agent_memories agent_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_profiles agent_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_tool_invocations agent_tool_invocations_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: agent_tool_invocations agent_tool_invocations_confirmation_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_confirmation_actor_user_id_fkey FOREIGN KEY (confirmation_actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_tool_invocations agent_tool_invocations_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.agent_connectors(id) ON DELETE SET NULL;


--
-- Name: agent_tool_invocations agent_tool_invocations_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: agent_tool_invocations agent_tool_invocations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_invocations
    ADD CONSTRAINT agent_tool_invocations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_tool_policies agent_tool_policies_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_policies
    ADD CONSTRAINT agent_tool_policies_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: ai_credit_usage_events ai_credit_usage_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_workflow_executions(id) ON DELETE SET NULL;


--
-- Name: ai_credit_usage_events ai_credit_usage_events_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;


--
-- Name: ai_credit_usage_events ai_credit_usage_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_credit_usage_events ai_credit_usage_events_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.capability_workflow_runs(id) ON DELETE SET NULL;


--
-- Name: ai_credit_usage_events ai_credit_usage_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_credit_usage_events
    ADD CONSTRAINT ai_credit_usage_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: ai_workflow_executions ai_workflow_executions_extraction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workflow_executions
    ADD CONSTRAINT ai_workflow_executions_extraction_id_fkey FOREIGN KEY (extraction_id) REFERENCES public.meeting_extractions(id) ON DELETE SET NULL;


--
-- Name: ai_workflow_executions ai_workflow_executions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workflow_executions
    ADD CONSTRAINT ai_workflow_executions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: ashby_candidate_email_lookups ashby_candidate_email_lookups_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_candidate_email_lookups
    ADD CONSTRAINT ashby_candidate_email_lookups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ashby_meeting_analyses ashby_meeting_analyses_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_meeting_analyses
    ADD CONSTRAINT ashby_meeting_analyses_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: ashby_member_connections ashby_member_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_member_connections
    ADD CONSTRAINT ashby_member_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ashby_member_connections ashby_member_connections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_member_connections
    ADD CONSTRAINT ashby_member_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ashby_review_actions ashby_review_actions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_review_actions
    ADD CONSTRAINT ashby_review_actions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: ashby_review_actions ashby_review_actions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_review_actions
    ADD CONSTRAINT ashby_review_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ashby_reviews ashby_reviews_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_reviews
    ADD CONSTRAINT ashby_reviews_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: ashby_reviews ashby_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_reviews
    ADD CONSTRAINT ashby_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ashby_reviews ashby_reviews_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ashby_reviews
    ADD CONSTRAINT ashby_reviews_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: assigned_task_placements assigned_task_placements_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assigned_task_placements
    ADD CONSTRAINT assigned_task_placements_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: assigned_task_placements assigned_task_placements_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assigned_task_placements
    ADD CONSTRAINT assigned_task_placements_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.workspace_task_sections(id) ON DELETE CASCADE;


--
-- Name: assigned_task_placements assigned_task_placements_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assigned_task_placements
    ADD CONSTRAINT assigned_task_placements_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: assigned_task_placements assigned_task_placements_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assigned_task_placements
    ADD CONSTRAINT assigned_task_placements_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: billing_customers billing_customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: billing_subscriptions billing_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: billing_subscriptions billing_subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_event_preps calendar_event_preps_calendar_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_preps
    ADD CONSTRAINT calendar_event_preps_calendar_account_id_fkey FOREIGN KEY (calendar_account_id) REFERENCES public.agent_connectors(id) ON DELETE CASCADE;


--
-- Name: calendar_event_preps calendar_event_preps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_preps
    ADD CONSTRAINT calendar_event_preps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calendar_ready_links calendar_ready_links_calendar_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_ready_links
    ADD CONSTRAINT calendar_ready_links_calendar_account_id_fkey FOREIGN KEY (calendar_account_id) REFERENCES public.agent_connectors(id) ON DELETE CASCADE;


--
-- Name: calendar_ready_links calendar_ready_links_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_ready_links
    ADD CONSTRAINT calendar_ready_links_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id);


--
-- Name: calendar_ready_links calendar_ready_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_ready_links
    ADD CONSTRAINT calendar_ready_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: calendar_sync_subscriptions calendar_sync_subscriptions_agent_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_subscriptions
    ADD CONSTRAINT calendar_sync_subscriptions_agent_connector_id_fkey FOREIGN KEY (agent_connector_id) REFERENCES public.agent_connectors(id) ON DELETE CASCADE;


--
-- Name: calendar_sync_subscriptions calendar_sync_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_subscriptions
    ADD CONSTRAINT calendar_sync_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: capability_workflow_messages capability_workflow_messages_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_messages
    ADD CONSTRAINT capability_workflow_messages_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.capability_workflow_runs(id) ON DELETE CASCADE;


--
-- Name: capability_workflow_runs capability_workflow_runs_capability_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_runs
    ADD CONSTRAINT capability_workflow_runs_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES public.capability_catalog(key);


--
-- Name: capability_workflow_runs capability_workflow_runs_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_runs
    ADD CONSTRAINT capability_workflow_runs_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: capability_workflow_runs capability_workflow_runs_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_workflow_runs
    ADD CONSTRAINT capability_workflow_runs_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.meeting_capability_recommendations(id) ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_grants
    ADD CONSTRAINT credit_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: credit_grants credit_grants_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_grants
    ADD CONSTRAINT credit_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: data_deletion_requests data_deletion_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: google_addon_conferences google_addon_conferences_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_addon_conferences
    ADD CONSTRAINT google_addon_conferences_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id) ON DELETE CASCADE;


--
-- Name: google_addon_conferences google_addon_conferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_addon_conferences
    ADD CONSTRAINT google_addon_conferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guest_auth_sessions guest_auth_sessions_join_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_join_request_id_fkey FOREIGN KEY (join_request_id) REFERENCES public.meeting_join_requests(id) ON DELETE CASCADE;


--
-- Name: guest_auth_sessions guest_auth_sessions_linked_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_linked_to_user_id_fkey FOREIGN KEY (linked_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: guest_auth_sessions guest_auth_sessions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: guest_auth_sessions guest_auth_sessions_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id) ON DELETE CASCADE;


--
-- Name: guest_auth_sessions guest_auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_auth_sessions
    ADD CONSTRAINT guest_auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guest_browser_identities guest_browser_identities_linked_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_identities
    ADD CONSTRAINT guest_browser_identities_linked_account_user_id_fkey FOREIGN KEY (linked_account_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: guest_browser_users guest_browser_users_browser_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_users
    ADD CONSTRAINT guest_browser_users_browser_id_fkey FOREIGN KEY (browser_id) REFERENCES public.guest_browser_identities(id) ON DELETE CASCADE;


--
-- Name: guest_browser_users guest_browser_users_guest_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_browser_users
    ADD CONSTRAINT guest_browser_users_guest_user_id_fkey FOREIGN KEY (guest_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guest_memory_account_links guest_memory_account_links_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_memory_account_links
    ADD CONSTRAINT guest_memory_account_links_account_user_id_fkey FOREIGN KEY (account_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guest_memory_account_links guest_memory_account_links_guest_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_memory_account_links
    ADD CONSTRAINT guest_memory_account_links_guest_user_id_fkey FOREIGN KEY (guest_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: linear_task_review_items linear_task_review_items_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_items
    ADD CONSTRAINT linear_task_review_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.linear_task_review_runs(id) ON DELETE CASCADE;


--
-- Name: linear_task_review_runs linear_task_review_runs_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_runs
    ADD CONSTRAINT linear_task_review_runs_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.agent_connectors(id) ON DELETE SET NULL;


--
-- Name: linear_task_review_runs linear_task_review_runs_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_runs
    ADD CONSTRAINT linear_task_review_runs_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: linear_task_review_runs linear_task_review_runs_task_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_runs
    ADD CONSTRAINT linear_task_review_runs_task_list_id_fkey FOREIGN KEY (task_list_id) REFERENCES public.meeting_task_lists(id) ON DELETE CASCADE;


--
-- Name: linear_task_review_runs linear_task_review_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_task_review_runs
    ADD CONSTRAINT linear_task_review_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_ambient_context_cursors meeting_ambient_context_cursors_last_processed_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_cursors
    ADD CONSTRAINT meeting_ambient_context_cursors_last_processed_segment_id_fkey FOREIGN KEY (last_processed_segment_id) REFERENCES public.transcript_segments(id) ON DELETE SET NULL;


--
-- Name: meeting_ambient_context_cursors meeting_ambient_context_cursors_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_cursors
    ADD CONSTRAINT meeting_ambient_context_cursors_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_ambient_context_items meeting_ambient_context_items_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_ambient_context_items
    ADD CONSTRAINT meeting_ambient_context_items_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_assets meeting_assets_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_assets
    ADD CONSTRAINT meeting_assets_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendance_intervals meeting_attendance_intervals_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendance_intervals
    ADD CONSTRAINT meeting_attendance_intervals_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendance_intervals meeting_attendance_intervals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendance_intervals
    ADD CONSTRAINT meeting_attendance_intervals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_attendee_workspaces meeting_attendee_workspaces_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendee_workspaces
    ADD CONSTRAINT meeting_attendee_workspaces_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendee_workspaces meeting_attendee_workspaces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendee_workspaces
    ADD CONSTRAINT meeting_attendee_workspaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_attendee_workspaces meeting_attendee_workspaces_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendee_workspaces
    ADD CONSTRAINT meeting_attendee_workspaces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: meeting_capability_recommendations meeting_capability_recommendations_capability_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_capability_recommendations
    ADD CONSTRAINT meeting_capability_recommendations_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES public.capability_catalog(key);


--
-- Name: meeting_capability_recommendations meeting_capability_recommendations_extraction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_capability_recommendations
    ADD CONSTRAINT meeting_capability_recommendations_extraction_id_fkey FOREIGN KEY (extraction_id) REFERENCES public.meeting_extractions(id) ON DELETE CASCADE;


--
-- Name: meeting_capability_recommendations meeting_capability_recommendations_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_capability_recommendations
    ADD CONSTRAINT meeting_capability_recommendations_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_extractions meeting_extractions_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_extractions
    ADD CONSTRAINT meeting_extractions_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_join_requests meeting_join_requests_decided_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_join_requests
    ADD CONSTRAINT meeting_join_requests_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meeting_join_requests meeting_join_requests_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_join_requests
    ADD CONSTRAINT meeting_join_requests_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_join_requests meeting_join_requests_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_join_requests
    ADD CONSTRAINT meeting_join_requests_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id) ON DELETE CASCADE;


--
-- Name: meeting_join_requests meeting_join_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_join_requests
    ADD CONSTRAINT meeting_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_link_call_ins meeting_link_call_ins_last_synced_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_link_call_ins
    ADD CONSTRAINT meeting_link_call_ins_last_synced_meeting_id_fkey FOREIGN KEY (last_synced_meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;


--
-- Name: meeting_link_call_ins meeting_link_call_ins_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_link_call_ins
    ADD CONSTRAINT meeting_link_call_ins_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id) ON DELETE CASCADE;


--
-- Name: meeting_links meeting_links_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_links
    ADD CONSTRAINT meeting_links_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: meeting_links meeting_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_links
    ADD CONSTRAINT meeting_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: meeting_live_task_candidate_evidence meeting_live_task_candidate_evidence_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidate_evidence
    ADD CONSTRAINT meeting_live_task_candidate_evidence_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.meeting_live_task_candidates(id) ON DELETE CASCADE;


--
-- Name: meeting_live_task_candidate_evidence meeting_live_task_candidate_evidence_speaker_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidate_evidence
    ADD CONSTRAINT meeting_live_task_candidate_evidence_speaker_user_id_fkey FOREIGN KEY (speaker_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meeting_live_task_candidate_evidence meeting_live_task_candidate_evidence_transcript_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidate_evidence
    ADD CONSTRAINT meeting_live_task_candidate_evidence_transcript_segment_id_fkey FOREIGN KEY (transcript_segment_id) REFERENCES public.transcript_segments(id) ON DELETE SET NULL;


--
-- Name: meeting_live_task_candidates meeting_live_task_candidates_linked_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidates
    ADD CONSTRAINT meeting_live_task_candidates_linked_task_id_fkey FOREIGN KEY (linked_task_id) REFERENCES public.meeting_tasks(id) ON DELETE SET NULL;


--
-- Name: meeting_live_task_candidates meeting_live_task_candidates_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidates
    ADD CONSTRAINT meeting_live_task_candidates_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_live_task_candidates meeting_live_task_candidates_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_candidates
    ADD CONSTRAINT meeting_live_task_candidates_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meeting_live_task_cursors meeting_live_task_cursors_last_processed_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_cursors
    ADD CONSTRAINT meeting_live_task_cursors_last_processed_segment_id_fkey FOREIGN KEY (last_processed_segment_id) REFERENCES public.transcript_segments(id) ON DELETE SET NULL;


--
-- Name: meeting_live_task_cursors meeting_live_task_cursors_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_live_task_cursors
    ADD CONSTRAINT meeting_live_task_cursors_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_participants meeting_participants_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_participants
    ADD CONSTRAINT meeting_participants_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_participants meeting_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_participants
    ADD CONSTRAINT meeting_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_research_runs meeting_research_runs_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_research_runs
    ADD CONSTRAINT meeting_research_runs_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: meeting_research_runs meeting_research_runs_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_research_runs
    ADD CONSTRAINT meeting_research_runs_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_research_runs meeting_research_runs_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_research_runs
    ADD CONSTRAINT meeting_research_runs_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.meeting_capability_recommendations(id) ON DELETE CASCADE;


--
-- Name: meeting_research_runs meeting_research_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_research_runs
    ADD CONSTRAINT meeting_research_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_suggested_action_runs meeting_suggested_action_runs_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_suggested_action_runs
    ADD CONSTRAINT meeting_suggested_action_runs_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_task_latency_observations meeting_task_latency_observations_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_latency_observations
    ADD CONSTRAINT meeting_task_latency_observations_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_task_latency_observations meeting_task_latency_observations_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_latency_observations
    ADD CONSTRAINT meeting_task_latency_observations_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.meeting_tasks(id) ON DELETE CASCADE;


--
-- Name: meeting_task_lists meeting_task_lists_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_task_lists
    ADD CONSTRAINT meeting_task_lists_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_tasks meeting_tasks_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_tasks
    ADD CONSTRAINT meeting_tasks_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_tasks meeting_tasks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_tasks
    ADD CONSTRAINT meeting_tasks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meeting_tasks meeting_tasks_status_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_tasks
    ADD CONSTRAINT meeting_tasks_status_actor_user_id_fkey FOREIGN KEY (status_actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meeting_tasks meeting_tasks_task_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_tasks
    ADD CONSTRAINT meeting_tasks_task_list_id_fkey FOREIGN KEY (task_list_id) REFERENCES public.meeting_task_lists(id) ON DELETE CASCADE;


--
-- Name: meeting_trackers meeting_trackers_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trackers
    ADD CONSTRAINT meeting_trackers_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_trial_slots meeting_trial_slots_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trial_slots
    ADD CONSTRAINT meeting_trial_slots_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;


--
-- Name: meeting_trial_slots meeting_trial_slots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trial_slots
    ADD CONSTRAINT meeting_trial_slots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meeting_trial_slots meeting_trial_slots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_trial_slots
    ADD CONSTRAINT meeting_trial_slots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: meeting_turns meeting_turns_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_turns
    ADD CONSTRAINT meeting_turns_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE RESTRICT;


--
-- Name: meeting_turns meeting_turns_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_turns
    ADD CONSTRAINT meeting_turns_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_turns meeting_turns_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_turns
    ADD CONSTRAINT meeting_turns_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_confidentiality_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_confidentiality_updated_by_user_id_fkey FOREIGN KEY (confidentiality_updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: meetings meetings_meeting_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_meeting_link_id_fkey FOREIGN KEY (meeting_link_id) REFERENCES public.meeting_links(id);


--
-- Name: meetings meetings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: memory_evidence memory_evidence_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_evidence
    ADD CONSTRAINT memory_evidence_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.relationship_memories(id) ON DELETE CASCADE;


--
-- Name: memory_evidence memory_evidence_segment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_evidence
    ADD CONSTRAINT memory_evidence_segment_id_fkey FOREIGN KEY (segment_id) REFERENCES public.transcript_segments(id) ON DELETE CASCADE;


--
-- Name: memory_generation_ledger memory_generation_ledger_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_generation_ledger
    ADD CONSTRAINT memory_generation_ledger_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: memory_generation_ledger memory_generation_ledger_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_generation_ledger
    ADD CONSTRAINT memory_generation_ledger_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE SET NULL;


--
-- Name: memory_generation_ledger memory_generation_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_generation_ledger
    ADD CONSTRAINT memory_generation_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_interactions memory_interactions_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_interactions
    ADD CONSTRAINT memory_interactions_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_interactions memory_interactions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_interactions
    ADD CONSTRAINT memory_interactions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;


--
-- Name: memory_people memory_people_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_people
    ADD CONSTRAINT memory_people_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_people memory_people_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_people
    ADD CONSTRAINT memory_people_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memory_person_identities memory_person_identities_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_identities
    ADD CONSTRAINT memory_person_identities_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_person_identities memory_person_identities_person_id_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_identities
    ADD CONSTRAINT memory_person_identities_person_id_user_id_workspace_id_fkey FOREIGN KEY (person_id, user_id, workspace_id) REFERENCES public.memory_people(id, user_id, workspace_id) ON DELETE CASCADE;


--
-- Name: memory_person_identities memory_person_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_identities
    ADD CONSTRAINT memory_person_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_person_identities memory_person_identities_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_identities
    ADD CONSTRAINT memory_person_identities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memory_person_names memory_person_names_participant_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_names
    ADD CONSTRAINT memory_person_names_participant_user_id_fkey FOREIGN KEY (participant_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_person_names memory_person_names_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_names
    ADD CONSTRAINT memory_person_names_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_person_names memory_person_names_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_names
    ADD CONSTRAINT memory_person_names_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;


--
-- Name: memory_person_projections memory_person_projections_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_projections
    ADD CONSTRAINT memory_person_projections_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_person_redirects memory_person_redirects_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_redirects
    ADD CONSTRAINT memory_person_redirects_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_person_redirects memory_person_redirects_target_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_person_redirects
    ADD CONSTRAINT memory_person_redirects_target_person_id_fkey FOREIGN KEY (target_person_id) REFERENCES public.memory_people(id) ON DELETE CASCADE;


--
-- Name: memory_preferences memory_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_preferences
    ADD CONSTRAINT memory_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_preferences memory_preferences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_preferences
    ADD CONSTRAINT memory_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memory_sensitivity_history memory_sensitivity_history_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sensitivity_history
    ADD CONSTRAINT memory_sensitivity_history_user_id_workspace_id_fkey FOREIGN KEY (user_id, workspace_id) REFERENCES public.memory_preferences(user_id, workspace_id) ON DELETE CASCADE;


--
-- Name: memory_sources memory_sources_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: memory_sources memory_sources_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_sources memory_sources_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memory_legacy_suppressions memory_suppressions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_legacy_suppressions
    ADD CONSTRAINT memory_suppressions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;


--
-- Name: memory_suppressions memory_suppressions_source_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_suppressions
    ADD CONSTRAINT memory_suppressions_source_id_fkey1 FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;


--
-- Name: memory_sync_changes memory_sync_changes_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sync_changes
    ADD CONSTRAINT memory_sync_changes_user_id_workspace_id_fkey FOREIGN KEY (user_id, workspace_id) REFERENCES public.memory_sync_heads(user_id, workspace_id) ON DELETE CASCADE;


--
-- Name: memory_sync_heads memory_sync_heads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sync_heads
    ADD CONSTRAINT memory_sync_heads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memory_sync_heads memory_sync_heads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sync_heads
    ADD CONSTRAINT memory_sync_heads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pending_google_addon_calendar_credentials pending_google_addon_calendar_credentia_agent_connector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_google_addon_calendar_credentials
    ADD CONSTRAINT pending_google_addon_calendar_credentia_agent_connector_id_fkey FOREIGN KEY (agent_connector_id) REFERENCES public.agent_connectors(id) ON DELETE CASCADE;


--
-- Name: personal_task_clearances personal_task_clearances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_clearances
    ADD CONSTRAINT personal_task_clearances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: personal_task_clearances personal_task_clearances_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_clearances
    ADD CONSTRAINT personal_task_clearances_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: personal_task_item_clearances personal_task_item_clearances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_item_clearances
    ADD CONSTRAINT personal_task_item_clearances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: personal_task_item_clearances personal_task_item_clearances_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_task_item_clearances
    ADD CONSTRAINT personal_task_item_clearances_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: private_beta_waitlist_entries private_beta_waitlist_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_beta_waitlist_entries
    ADD CONSTRAINT private_beta_waitlist_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: relationship_memories relationship_memories_candidate_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_memories
    ADD CONSTRAINT relationship_memories_candidate_subject_id_fkey FOREIGN KEY (candidate_subject_id) REFERENCES public.memory_people(id) ON DELETE SET NULL;


--
-- Name: relationship_memories relationship_memories_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_memories
    ADD CONSTRAINT relationship_memories_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;


--
-- Name: slack_delivery_configs slack_delivery_configs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_delivery_configs
    ADD CONSTRAINT slack_delivery_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: slack_meeting_deliveries slack_meeting_deliveries_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_deliveries
    ADD CONSTRAINT slack_meeting_deliveries_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: slack_meeting_deliveries slack_meeting_deliveries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_deliveries
    ADD CONSTRAINT slack_meeting_deliveries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: slack_meeting_reviews slack_meeting_reviews_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_reviews
    ADD CONSTRAINT slack_meeting_reviews_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: slack_meeting_reviews slack_meeting_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_meeting_reviews
    ADD CONSTRAINT slack_meeting_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: slack_review_deliveries slack_review_deliveries_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_review_deliveries
    ADD CONSTRAINT slack_review_deliveries_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.slack_meeting_reviews(id) ON DELETE CASCADE;


--
-- Name: summaries summaries_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.summaries
    ADD CONSTRAINT summaries_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: transcript_segments transcript_segments_agent_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_agent_owner_user_id_fkey FOREIGN KEY (agent_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transcript_segments transcript_segments_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE SET NULL;


--
-- Name: transcript_segments transcript_segments_meeting_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_meeting_turn_id_fkey FOREIGN KEY (meeting_turn_id) REFERENCES public.meeting_turns(id) ON DELETE SET NULL;


--
-- Name: transcript_segments transcript_segments_speaker_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_speaker_user_id_fkey FOREIGN KEY (speaker_user_id) REFERENCES public.users(id);


--
-- Name: transcript_segments transcript_segments_transcript_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_segments
    ADD CONSTRAINT transcript_segments_transcript_id_fkey FOREIGN KEY (transcript_id) REFERENCES public.transcripts(id) ON DELETE CASCADE;


--
-- Name: transcripts transcripts_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: usage_events usage_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.ai_workflow_executions(id) ON DELETE SET NULL;


--
-- Name: usage_events usage_events_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE SET NULL;


--
-- Name: usage_events usage_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: usage_events usage_events_workflow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.capability_workflow_runs(id) ON DELETE SET NULL;


--
-- Name: user_acquisition user_acquisition_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_acquisition
    ADD CONSTRAINT user_acquisition_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_acquisition user_acquisition_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_acquisition
    ADD CONSTRAINT user_acquisition_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: user_auth_accounts user_auth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_auth_accounts
    ADD CONSTRAINT user_auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_capability_preferences user_capability_preferences_capability_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_capability_preferences
    ADD CONSTRAINT user_capability_preferences_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES public.capability_catalog(key);


--
-- Name: user_capability_preferences user_capability_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_capability_preferences
    ADD CONSTRAINT user_capability_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_media_preferences user_media_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_preferences
    ADD CONSTRAINT user_media_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_active_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_active_workspace_id_fkey FOREIGN KEY (active_workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: voice_web_research_runs voice_web_research_runs_agent_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_web_research_runs
    ADD CONSTRAINT voice_web_research_runs_agent_profile_id_fkey FOREIGN KEY (agent_profile_id) REFERENCES public.agent_profiles(id) ON DELETE CASCADE;


--
-- Name: voice_web_research_runs voice_web_research_runs_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_web_research_runs
    ADD CONSTRAINT voice_web_research_runs_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: voice_web_research_runs voice_web_research_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_web_research_runs
    ADD CONSTRAINT voice_web_research_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_ashby_integrations workspace_ashby_integrations_configured_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_ashby_integrations
    ADD CONSTRAINT workspace_ashby_integrations_configured_by_user_id_fkey FOREIGN KEY (configured_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_ashby_integrations workspace_ashby_integrations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_ashby_integrations
    ADD CONSTRAINT workspace_ashby_integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_audit_events workspace_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_audit_events
    ADD CONSTRAINT workspace_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_audit_events workspace_audit_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_audit_events
    ADD CONSTRAINT workspace_audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_billing_customers workspace_billing_customers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_billing_customers
    ADD CONSTRAINT workspace_billing_customers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invitations workspace_invitations_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invitations workspace_invitations_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invitations workspace_invitations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_memberships workspace_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_memberships workspace_memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_task_sections workspace_task_sections_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_task_sections
    ADD CONSTRAINT workspace_task_sections_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_task_sections workspace_task_sections_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_task_sections
    ADD CONSTRAINT workspace_task_sections_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_task_sections workspace_task_sections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_task_sections
    ADD CONSTRAINT workspace_task_sections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_tasks workspace_tasks_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tasks
    ADD CONSTRAINT workspace_tasks_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tasks workspace_tasks_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tasks
    ADD CONSTRAINT workspace_tasks_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tasks workspace_tasks_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tasks
    ADD CONSTRAINT workspace_tasks_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tasks workspace_tasks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tasks
    ADD CONSTRAINT workspace_tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--



INSERT INTO public.capability_catalog (key, name, description, category, applicable_meeting_types, required_signals, exclusion_signals, example_triggers, side_effect_scope, default_priority, is_active, metadata) VALUES ('meeting_coaching', 'Meeting Feedback', 'Review the meeting and suggest ways to make the next one clearer, tighter, and more useful.', 'preparation', '["team_sync","one_on_one","sales_call","customer_success","product_review","standup","interview","planning","brainstorm","retrospective","postmortem","manager_check_in","other"]', '[]', '[]', '["Give me feedback on how this meeting went.","Help me improve the next version of this conversation."]', 'none', '40', 'true', '{"alwaysAvailable":true,"integrationTargets":[]}');

INSERT INTO public.capability_catalog (key, name, description, category, applicable_meeting_types, required_signals, exclusion_signals, example_triggers, side_effect_scope, default_priority, is_active, metadata) VALUES ('draft_participant_follow_up', 'Participant Follow-Up', 'Draft a follow-up message for the meeting participants without sending anything automatically.', 'communication', '["team_sync","one_on_one","sales_call","customer_success","product_review","standup","interview","planning","brainstorm","retrospective","postmortem","manager_check_in","other"]', '[]', '[]', '["Draft a follow-up for the people in this meeting.","Help me send everyone a clear recap after this conversation."]', 'private_draft', '39', 'true', '{"alwaysAvailable":true,"integrationTargets":["Gmail","Outlook"]}');

INSERT INTO public.ai_credit_pricing_config (price_per_credit_micro_usd, target_markup_multiplier, included_action_types, action_minimum_credits, metadata) VALUES ('100000', '5.0000', '["meeting_snapshot"]', '{"meeting_ask":1,"meeting_prep":1,"meeting_brief":0,"agent_workflow":10,"meeting_summary":3,"coaching_feedback":5,"mail_thread_summary":0,"followup_email_draft":3,"meeting_action_items":3,"deep_meeting_analysis":10,"linear_issue_drafting":8,"mail_surface_classification":0}', '{"source":"default_seed"}');

-- Establish the same future-only boundary at installation time, not snapshot time.
INSERT INTO public.memory_runtime_policy (id) VALUES (true);
