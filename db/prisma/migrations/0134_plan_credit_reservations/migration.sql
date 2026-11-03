CREATE TABLE ai_credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('pro', 'max')),
  maximum_cost_micro_usd integer NOT NULL CHECK (maximum_cost_micro_usd >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_credits integer NOT NULL CHECK (reserved_credits >= 0),
  allowance_credits integer NOT NULL CHECK (allowance_credits >= 0 AND allowance_credits <= reserved_credits),
  pool_debits jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowance_window_start timestamptz,
  included boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
ALTER TABLE ai_credit_usage_events ADD COLUMN reservation_id uuid REFERENCES ai_credit_reservations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ai_credit_usage_reservation_unique ON ai_credit_usage_events(reservation_id);
-- Pending holds are summed on every admission. Completed history stays out of that scan.
CREATE INDEX ai_credit_reservations_reserved_allowance_idx
  ON ai_credit_reservations (workspace_id, user_id, allowance_window_start)
  WHERE status = 'reserved';

-- Direct usage rows still debit grants. Reservation settlements skip that path.
CREATE OR REPLACE FUNCTION debit_ai_usage_credits() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- Reservations already own their pool debit and allowance allocation.
  IF NEW.reservation_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM ai_credit_reservations WHERE id = NEW.reservation_id
      AND workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND status = 'settled'
      AND NEW.actual_cost_micro_usd BETWEEN 0 AND maximum_cost_micro_usd
      AND NEW.credits_charged BETWEEN 0 AND reserved_credits
      AND NEW.included = included) THEN
      RAISE EXCEPTION 'Invalid AI credit settlement';
    END IF;
    RETURN NEW;
  END IF;
  -- Record zero even on early returns; keep AFTER INSERT so ON CONFLICT replays never debit.
  IF NEW.workspace_id IS NOT NULL THEN
    UPDATE ai_credit_usage_events
      SET metadata = metadata || jsonb_build_object('allowanceCredits', 0)
      WHERE id = NEW.id;
  END IF;
  IF remaining = 0 THEN RETURN NEW; END IF;
  -- User first, then workspace, so grant locks stay in one order.
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
          SELECT COALESCE(sum(COALESCE((metadata->>'allowanceCredits')::integer, credits_charged)), 0)
            INTO used_before FROM ai_credit_usage_events
            WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND id <> NEW.id
            AND created_at >= window_start AND created_at < window_end;
          -- Pending reservations hold allowance even while the provider is running.
          SELECT used_before + COALESCE(sum(allowance_credits), 0) INTO used_before
            FROM ai_credit_reservations WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id
            AND status = 'reserved' AND allowance_window_start = window_start;
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
  IF allowance > 0 THEN
    UPDATE ai_credit_usage_events
      SET metadata = metadata || jsonb_build_object('allowanceCredits', allowance)
      WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
