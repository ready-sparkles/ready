import { calculatePlanCredits, CREDIT_PRICE_MICRO_USD, type CreditPlan, PLAN_CREDITS } from "@readymeet/shared";
import { z } from "zod";

import { InsufficientAiCreditsError, PaidPlanRequiredForCreditsError } from "../../../domain/persistence-errors";

import { db, type DbTransaction, type Prisma } from "./client";
import {
  getCurrentMonthlyWindow,
  getRunningBillingSubscriptionForWorkspace,
  planCreditGrantConsumption,
  sumWorkspaceMemberUsageBetween,
} from "./workspace-billing";

const DECIMAL_SCALE = 4;
const MEETING_CREDIT_ROUNDING = "meeting-total-v1";

type Tx = DbTransaction;
type ReservationRow = Awaited<ReturnType<typeof db.aiCreditReservations.findUniqueOrThrow>>;
type UsageEventRow = Awaited<ReturnType<typeof db.aiCreditUsageEvents.findUniqueOrThrow>>;
type Reservation = ReturnType<typeof toReservation>;
type UsageEvent = ReturnType<typeof toUsageEvent>;

function toReservation(row: ReservationRow) {
  return {
    ...row,
    plan: z.enum(["pro", "max"]).parse(row.plan),
    status: z.enum(["reserved", "settled", "released"]).parse(row.status),
    metadata: z.record(z.unknown()).parse(row.metadata),
    poolDebits: z.array(z.object({ id: z.string(), credits: z.number() })).parse(row.poolDebits),
  };
}

function toUsageEvent(row: UsageEventRow) {
  return {
    ...row,
    markupMultiplier: row.markupMultiplier.toFixed(DECIMAL_SCALE),
    metadata: z.record(z.unknown()).parse(row.metadata),
  };
}

const jsonValueSchema: z.ZodType<Prisma.InputJsonValue | null> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);
const metadataSchema = z.record(jsonValueSchema);

const WORKSPACE_NOT_FOUND_MESSAGE = "Workspace not found.";
const INVALID_RESERVATION_MESSAGE = "Invalid AI credit reservation.";
const OVER_BUDGET_MESSAGE = "AI usage exceeds reserved cost or credits.";
const INVALID_LEDGER_AMOUNT_MESSAGE = "AI usage amounts must fit nonnegative ledger integers.";
const MISSING_SETTLEMENT_MESSAGE = "AI credit settlement event not found.";
const LEDGER_MAX_INTEGER = 2_147_483_647;
/**
 * A hold still "reserved" after this long lost its settlement (a crash or an
 * unknown provider outcome kept it for reconciliation). The longest legitimate
 * hold, calendar-prep research, settles well within a day.
 */
export const STALE_PLAN_CREDIT_RESERVATION_MS = 86_400_000;

function validateLedgerAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > LEDGER_MAX_INTEGER) {
    throw new RangeError(INVALID_LEDGER_AMOUNT_MESSAGE);
  }
}

async function lockWorkspace(input: { tx: Tx; workspaceId: string }) {
  const [workspace] = await input.tx.$queryRaw<{ id: string; plan: string }[]>`
    SELECT id, plan FROM workspaces WHERE id = ${input.workspaceId}::uuid FOR NO KEY UPDATE
  `;
  if (!workspace) {
    throw new Error(WORKSPACE_NOT_FOUND_MESSAGE);
  }

  return workspace;
}

async function remainingAllowance(input: {
  tx: Tx;
  workspaceId: string;
  userId: string;
  window: ReturnType<typeof getCurrentMonthlyWindow>;
  allowance: number;
}): Promise<number> {
  if (!input.window) {
    return 0;
  }
  const used = await sumWorkspaceMemberUsageBetween({
    executor: input.tx,
    workspaceId: input.workspaceId,
    userId: input.userId,
    from: input.window.windowStart,
    to: input.window.windowEnd,
  });
  const pending = await input.tx.aiCreditReservations.aggregate({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "reserved",
      allowanceWindowStart: input.window.windowStart,
    },
    _sum: { allowanceCredits: true },
  });

  return Math.max(0, input.allowance - used - (pending._sum.allowanceCredits ?? 0));
}

async function holdPoolCredits(input: {
  tx: Tx;
  workspaceId: string;
  credits: number;
  now: Date;
}): Promise<Reservation["poolDebits"]> {
  if (input.credits === 0) {
    return [];
  }
  const grants = await input.tx.$queryRaw<{ id: string; creditsRemaining: number }[]>`
    SELECT id, credits_remaining AS "creditsRemaining" FROM credit_grants
    WHERE workspace_id = ${input.workspaceId}::uuid AND credits_remaining > 0
      AND (expires_at IS NULL OR expires_at > ${input.now})
    ORDER BY expires_at ASC NULLS LAST, created_at, id FOR UPDATE
  `;
  const draw = planCreditGrantConsumption({ grants, credits: input.credits });
  if (draw.uncoveredCredits > 0) {
    throw new InsufficientAiCreditsError();
  }
  await Promise.all(
    draw.consumed.map((debit) =>
      // Debit the locked grant in the reservation transaction without a stale read-modify-write.
      input.tx.creditGrants.updateMany({
        where: { id: debit.id },
        data: { creditsRemaining: { decrement: debit.consume }, updatedAt: input.now },
      }),
    ),
  );

  return draw.consumed.map((debit) => ({ id: debit.id, credits: debit.consume }));
}

function staleReservationWhere(input: { workspaceId: string; now: Date }) {
  return {
    workspaceId: input.workspaceId,
    status: "reserved",
    createdAt: { lt: new Date(input.now.getTime() - STALE_PLAN_CREDIT_RESERVATION_MS) },
  };
}

/** Caller holds the workspace lock, so a stale hold is refunded at most once and never races its settlement. */
async function releaseStaleReservationsWithin(input: { tx: Tx; workspaceId: string; now: Date }): Promise<number> {
  const rows = await input.tx.aiCreditReservations.findMany({ where: staleReservationWhere(input) });
  await rows.reduce(async (previous, row) => {
    await previous;
    await refundUnusedPool({ tx: input.tx, reservation: toReservation(row), poolCost: 0 });
    await input.tx.aiCreditReservations.update({
      where: { id: row.id },
      data: { status: "released", settledAt: input.now },
    });
  }, Promise.resolve());

  return rows.length;
}

/**
 * Returns orphaned holds to the workspace: their pool debits go back to the
 * grants and their allowance stops counting as pending. Cheap when nothing is
 * stale, so balance reads can call it before showing credits.
 */
export async function releaseStalePlanCreditReservations(input: { workspaceId: string; now?: Date }): Promise<number> {
  const now = input.now ?? new Date();
  const stale = await db.aiCreditReservations.findFirst({
    where: staleReservationWhere({ workspaceId: input.workspaceId, now }),
    select: { id: true },
  });
  if (stale === null) {
    return 0;
  }

  return db.$transaction(async (tx) => {
    await lockWorkspace({ tx, workspaceId: input.workspaceId });

    return releaseStaleReservationsWithin({ tx, workspaceId: input.workspaceId, now });
  });
}

/**
 * Credits a member could spend that live holds have set aside: their own
 * allowance holds plus every pool hold in the workspace. A hold settles to the
 * actual charge and refunds the rest, so these are not spent yet. With a
 * meetingId, only that meeting's holds count, so another meeting's run never
 * makes this meeting's next run look affordable.
 */
export async function sumHeldPlanCredits(input: {
  workspaceId: string;
  userId: string;
  meetingId?: string;
}): Promise<number> {
  const holds = await db.aiCreditReservations.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: "reserved",
      ...(input.meetingId === undefined ? {} : { metadata: { path: ["meetingId"], equals: input.meetingId } }),
    },
    select: { userId: true, reservedCredits: true, allowanceCredits: true },
  });

  return holds.reduce(
    (total, hold) => total + hold.reservedCredits - (hold.userId === input.userId ? 0 : hold.allowanceCredits),
    0,
  );
}

export async function reservePlanCredits(input: {
  workspaceId: string;
  userId: string;
  maximumCostMicroUsd: number;
  isIncluded: boolean;
  metadata?: Record<string, unknown>;
}): Promise<Reservation> {
  validateLedgerAmount(input.maximumCostMicroUsd);

  // The workspace lock must cover the balance check, pool debit, and reservation insert atomically.
  return db.$transaction(async (tx) => {
    const workspace = await lockWorkspace({ tx, workspaceId: input.workspaceId });
    const now = new Date();
    // Orphaned holds must not keep blocking new work against credits nobody is spending.
    await releaseStaleReservationsWithin({ tx, workspaceId: input.workspaceId, now });
    const member = await tx.workspaceMemberships.findFirst({
      where: { workspaceId: input.workspaceId, userId: input.userId, status: "active", users: { deletedAt: null } },
    });
    if (!member) {
      throw new InsufficientAiCreditsError();
    }
    if (!input.isIncluded && workspace.plan !== "pro" && workspace.plan !== "max") {
      throw new PaidPlanRequiredForCreditsError();
    }
    const plan: CreditPlan = workspace.plan === "max" ? "max" : "pro";
    const credits = calculatePlanCredits({
      providerCostMicroUsd: input.maximumCostMicroUsd,
      plan,
      isIncluded: input.isIncluded,
    });
    validateLedgerAmount(credits * CREDIT_PRICE_MICRO_USD);
    const subscription = await getRunningBillingSubscriptionForWorkspace({
      workspaceId: input.workspaceId,
      executor: tx,
      now,
    });
    const window = subscription?.currentPeriodStart
      ? getCurrentMonthlyWindow({
          anchor: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          now,
        })
      : null;
    const allowance = await remainingAllowance({
      tx,
      ...input,
      window,
      allowance: subscription?.includedCreditsPerPeriod ?? 0,
    });
    const allowanceCredits = Math.min(allowance, credits);
    const poolDebits = await holdPoolCredits({
      tx,
      workspaceId: input.workspaceId,
      credits: credits - allowanceCredits,
      now,
    });
    const metadata = metadataSchema.parse(JSON.parse(JSON.stringify(input.metadata ?? {})));
    delete metadata.creditRounding;
    if (!input.isIncluded && typeof metadata.meetingId === "string") {
      z.string().uuid().parse(metadata.meetingId);
      metadata.creditRounding = MEETING_CREDIT_ROUNDING;
    }
    const reservation = await tx.aiCreditReservations.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        plan,
        maximumCostMicroUsd: input.maximumCostMicroUsd,
        metadata,
        reservedCredits: credits,
        allowanceCredits,
        poolDebits,
        allowanceWindowStart: window?.windowStart ?? null,
        /** @external ai_credit_reservations column */
        included: input.isIncluded,
        createdAt: now,
      },
    });

    return toReservation(reservation);
  });
}

async function refundUnusedPool(input: { tx: Tx; reservation: Reservation; poolCost: number }): Promise<void> {
  const draw = planCreditGrantConsumption({
    grants: input.reservation.poolDebits.map((debit) => ({ id: debit.id, creditsRemaining: debit.credits })),
    credits: input.poolCost,
  });
  await Promise.all(
    input.reservation.poolDebits.map((debit) => {
      const refund = debit.credits - (draw.consumed.find((consumed) => consumed.id === debit.id)?.consume ?? 0);
      if (refund === 0) {
        return Promise.resolve();
      }

      // Atomic addition preserves concurrent grant adjustments when returning unused held credits.
      return input.tx.creditGrants.updateMany({
        where: { id: debit.id, workspaceId: input.reservation.workspaceId },
        data: { creditsRemaining: { increment: refund }, updatedAt: new Date() },
      });
    }),
  );
}

export async function getPlanCreditReservation(input: {
  reservationId: string;
  workspaceId: string;
  userId: string;
}): Promise<Reservation | null> {
  const reservation = await db.aiCreditReservations.findFirst({
    where: { id: input.reservationId, workspaceId: input.workspaceId, userId: input.userId },
  });

  return reservation === null ? null : toReservation(reservation);
}

async function findReservation(input: {
  tx: Tx;
  reservationId: string;
  workspaceId: string;
  userId: string;
}): Promise<Reservation> {
  const [locked] = await input.tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ai_credit_reservations
    WHERE id = ${input.reservationId}::uuid AND workspace_id = ${input.workspaceId}::uuid
      AND user_id = ${input.userId}::uuid FOR UPDATE
  `;
  if (!locked) {
    throw new Error(INVALID_RESERVATION_MESSAGE);
  }
  const reservation = await input.tx.aiCreditReservations.findUniqueOrThrow({ where: { id: locked.id } });

  return toReservation(reservation);
}

async function meetingSettlementCredits(input: {
  tx: Tx;
  reservation: Reservation;
  meetingId: string | undefined;
  providerCostMicroUsd: number;
}): Promise<number> {
  const { tx, reservation, meetingId, providerCostMicroUsd } = input;
  if (
    reservation.metadata.creditRounding !== MEETING_CREDIT_ROUNDING ||
    reservation.included ||
    providerCostMicroUsd === 0
  ) {
    return calculatePlanCredits({ providerCostMicroUsd, plan: reservation.plan, isIncluded: reservation.included });
  }
  // The workspace lock serializes this total with every settlement in the group.
  const [totals] = await tx.$queryRaw<{ cost: bigint; credits: bigint }[]>`
    SELECT COALESCE(sum(e.actual_cost_micro_usd), 0) AS cost,
      COALESCE(sum(e.credits_charged), 0) AS credits
    FROM ai_credit_usage_events e JOIN ai_credit_reservations r ON r.id = e.reservation_id
    WHERE e.workspace_id = ${reservation.workspaceId}::uuid AND e.user_id = ${reservation.userId}::uuid
      AND e.meeting_id = ${meetingId}::uuid AND e.included = false
      AND e.metadata->>'creditRounding' = ${MEETING_CREDIT_ROUNDING}
      AND r.workspace_id = e.workspace_id AND r.user_id = e.user_id
      AND r.metadata->>'creditRounding' = ${MEETING_CREDIT_ROUNDING}
      AND r.metadata->>'meetingId' = ${meetingId} AND r.status = 'settled'
      AND r.plan = ${reservation.plan}
      AND r.allowance_window_start IS NOT DISTINCT FROM ${reservation.allowanceWindowStart}::timestamptz
  `;
  const cost = Number(totals?.cost ?? 0) + providerCostMicroUsd;
  const credits =
    calculatePlanCredits({ providerCostMicroUsd: cost, plan: reservation.plan, isIncluded: false }) -
    Number(totals?.credits ?? 0);
  validateLedgerAmount(credits);

  return credits;
}

export async function settlePlanCredits(input: {
  reservationId: string;
  workspaceId: string;
  userId: string;
  providerCostMicroUsd: number;
  provider: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  meetingId?: string;
  actionType?: string;
}): Promise<UsageEvent> {
  validateLedgerAmount(input.providerCostMicroUsd);
  validateLedgerAmount(input.inputTokens);
  validateLedgerAmount(input.outputTokens);
  validateLedgerAmount(input.cachedInputTokens ?? 0);

  // The status transition, refund, and unique usage event must commit together under the workspace lock.
  return db.$transaction(async (tx) => {
    await lockWorkspace({ tx, workspaceId: input.workspaceId });
    const reservation = await findReservation({ tx, ...input });
    const meetingId =
      reservation.metadata.creditRounding === MEETING_CREDIT_ROUNDING
        ? z.string().uuid().parse(reservation.metadata.meetingId)
        : input.meetingId;
    if (input.meetingId !== undefined && meetingId !== input.meetingId) {
      throw new Error(INVALID_RESERVATION_MESSAGE);
    }
    if (reservation.status === "released") {
      throw new Error(INVALID_RESERVATION_MESSAGE);
    }
    if (reservation.status === "settled") {
      const event = await tx.aiCreditUsageEvents.findUnique({ where: { reservationId: reservation.id } });
      if (!event) {
        throw new Error(MISSING_SETTLEMENT_MESSAGE);
      }

      return toUsageEvent(event);
    }
    if (input.providerCostMicroUsd > reservation.maximumCostMicroUsd) {
      throw new Error(OVER_BUDGET_MESSAGE);
    }
    const credits = await meetingSettlementCredits({
      tx,
      reservation,
      meetingId,
      providerCostMicroUsd: input.providerCostMicroUsd,
    });
    if (credits > reservation.reservedCredits) {
      throw new Error(OVER_BUDGET_MESSAGE);
    }
    const allowanceCredits = Math.min(credits, reservation.allowanceCredits);
    await refundUnusedPool({ tx, reservation, poolCost: credits - allowanceCredits });
    await tx.aiCreditReservations.update({
      where: { id: reservation.id },
      data: { status: "settled", settledAt: new Date() },
    });
    const revenue = credits * CREDIT_PRICE_MICRO_USD;
    const event = await tx.aiCreditUsageEvents.create({
      data: {
        reservationId: reservation.id,
        userId: input.userId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        model: input.model,
        actionType: input.actionType ?? "agent_workflow",
        meetingId,
        actionLabel: input.feature,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        actualCostMicroUsd: input.providerCostMicroUsd,
        creditsCharged: credits,
        /** @external ai_credit_usage_events column */
        included: reservation.included,
        pricePerCreditMicroUsd: CREDIT_PRICE_MICRO_USD,
        markupMultiplier: String(1 / (1 - PLAN_CREDITS[reservation.plan].grossMargin)),
        revenueMicroUsd: revenue,
        profitMicroUsd: revenue - input.providerCostMicroUsd,
        metadata: {
          ...(reservation.metadata.creditRounding === MEETING_CREDIT_ROUNDING
            ? { creditRounding: MEETING_CREDIT_ROUNDING }
            : {}),
          allowanceCredits,
          plan: reservation.plan,
          grossMargin: revenue > 0 ? (revenue - input.providerCostMicroUsd) / revenue : null,
          settledAt: new Date().toISOString(),
        },
        // Usage belongs to the allowance window in which it was authorized, even if settlement is later.
        createdAt: reservation.createdAt,
        idempotencyKey: `reservation:${reservation.id}`,
      },
    });

    return toUsageEvent(event);
  });
}

export async function releasePlanCredits(input: {
  reservationId: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  // Serialize release with settlement so a held pool debit can only be refunded once.
  await db.$transaction(async (tx) => {
    await lockWorkspace({ tx, workspaceId: input.workspaceId });
    const reservation = await findReservation({ tx, ...input });
    if (reservation.status !== "reserved") {
      return;
    }
    await refundUnusedPool({ tx, reservation, poolCost: 0 });
    await tx.aiCreditReservations.update({
      where: { id: reservation.id },
      data: { status: "released", settledAt: new Date() },
    });
  });
}
