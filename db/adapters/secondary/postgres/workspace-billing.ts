import { BILLING_PAST_DUE_GRACE_DAYS } from "@readymeet/shared";

import { db, type DbTransaction, Prisma } from "./client";

/**
 * Workspace-subject billing: Stripe customers/subscriptions keyed on a
 * workspace, the shared workspace credit pool, the per-member derived
 * allowance math, and the seat-sync outbox. Self-contained on purpose —
 * repositories.ts imports from here (never the other way) so the credit
 * charge path can branch into workspace draws without a module cycle.
 */

type DbExecutor = typeof db | DbTransaction;

/** Compatibility field only; free access is counted in hosted meetings. */
export const FREE_TRIAL_CREDITS = 0;
export const TRIAL_WORKSPACE_SLOTS = 3;

/**
 * Stripe statuses that may keep paid features unlocked. `past_due` is further
 * bounded by the grace window in runningSubscriptionConditions.
 */

export const ENTITLED_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

export type CreditGrantSource = "subscription_period" | "credit_topup" | "promotional";

type WorkspacePlan = "free" | "pro" | "max" | "business" | "business_multilingual" | "enterprise";
type WorkspaceBillingCustomerRow = Awaited<ReturnType<typeof db.workspaceBillingCustomers.findUniqueOrThrow>>;
type BillingSubscriptionRecord = Awaited<ReturnType<typeof db.billingSubscriptions.findUniqueOrThrow>>;
type BillingSubscriptionRow = Omit<BillingSubscriptionRecord, "metadata"> & { metadata: Record<string, unknown> };
type CreditGrantRecord = Awaited<ReturnType<typeof db.creditGrants.findUniqueOrThrow>>;
type CreditGrantRow = Omit<CreditGrantRecord, "source" | "metadata"> & {
  source: CreditGrantSource;
  metadata: Record<string, unknown>;
};

const MONTHLY_WINDOW_ITERATION_CAP = 12;
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const WORKSPACE_BILLING_SUBSCRIPTION_UPSERT_EMPTY_MESSAGE =
  "Workspace billing subscription upsert did not return a row";
const MESSAGE_METADATA_MUST_BE_JSON = "Billing metadata must be JSON.";
const MESSAGE_METADATA_MUST_BE_JSON_OBJECT = "Billing metadata must be a JSON object.";
const MESSAGE_UNEXPECTED_CREDIT_GRANT_SOURCE = "Unexpected credit grant source.";
const MESSAGE_UNEXPECTED_WORKSPACE_PLAN = "Unexpected workspace plan.";

const isEntitledSubscriptionStatus = (status: string): boolean => status === "active" || status === "trialing";

function isCreditGrantSource(source: string): source is CreditGrantSource {
  return source === "subscription_period" || source === "credit_topup" || source === "promotional";
}

function creditGrantSource(source: string): CreditGrantSource {
  if (isCreditGrantSource(source)) {
    return source;
  }

  throw new Error(MESSAGE_UNEXPECTED_CREDIT_GRANT_SOURCE);
}

function isWorkspacePlan(plan: string): plan is WorkspacePlan {
  return (
    plan === "free" ||
    plan === "pro" ||
    plan === "max" ||
    plan === "business" ||
    plan === "business_multilingual" ||
    plan === "enterprise"
  );
}

function workspacePlan(plan: string): WorkspacePlan {
  if (isWorkspacePlan(plan)) {
    return plan;
  }

  throw new Error(MESSAGE_UNEXPECTED_WORKSPACE_PLAN);
}

function toInputJson(value: unknown): Prisma.InputJsonValue | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const json = toInputJson(item);

      return json ?? null;
    });
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce<Record<string, Prisma.InputJsonValue | null>>((json, [key, item]) => {
      const converted = toInputJson(item);
      if (converted === undefined) {
        return json;
      }

      return { ...json, [key]: converted };
    }, {});
  }

  return undefined;
}

function toInputJsonRecord(record: Record<string, unknown>): Prisma.InputJsonValue {
  const json = toInputJson(record);
  if (json === undefined || json === null) {
    throw new Error(MESSAGE_METADATA_MUST_BE_JSON);
  }

  return json;
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(MESSAGE_METADATA_MUST_BE_JSON_OBJECT);
  }

  return Object.entries(value).reduce<Record<string, unknown>>((record, [key, item]) => {
    return { ...record, [key]: item };
  }, {});
}

function toBillingSubscription(row: BillingSubscriptionRecord): BillingSubscriptionRow {
  return { ...row, metadata: jsonRecord(row.metadata) };
}

function toCreditGrant(row: CreditGrantRecord): CreditGrantRow {
  return { ...row, source: creditGrantSource(row.source), metadata: jsonRecord(row.metadata) };
}

// --- Pure math ---------------------------------------------------------------

function addUtcMonths(input: { date: Date; months: number }): Date {
  const result = new Date(input.date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + input.months);
  const daysInMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, daysInMonth));

  return result;
}

/**
 * The monthly allowance window containing `now`, anchored on the
 * subscription period start (NOT calendar months — a subscription started on
 * the 20th refreshes on the 20th). Null when the subscription period has
 * ended or has not started; windowEnd is unclamped so usage sums stay stable,
 * callers clamp against periodEnd where expiry matters.
 */
export function getCurrentMonthlyWindow(input: {
  anchor: Date;
  now?: Date;
  periodEnd?: Date | null;
}): { windowIndex: number; windowStart: Date; windowEnd: Date } | null {
  const now = input.now ?? new Date();
  if (input.periodEnd && now >= input.periodEnd) {
    return null;
  }

  const window = Array.from({ length: MONTHLY_WINDOW_ITERATION_CAP }, (_, index) => index).reduce(
    (current) => {
      if (current.windowEnd > now) {
        return current;
      }
      const windowIndex = current.windowIndex + 1;

      return {
        windowIndex,
        windowStart: current.windowEnd,
        windowEnd: addUtcMonths({ date: input.anchor, months: windowIndex + 1 }),
      };
    },
    {
      windowIndex: 0,
      windowStart: input.anchor,
      windowEnd: addUtcMonths({ date: input.anchor, months: 1 }),
    },
  );
  // The 12-iteration cap only bounds the loop; a stale anchor (>13 months
  // old with no periodEnd) leaves `now` outside the capped window. There is
  // no current window then — returning it would compute allowance usage
  // against long-dead dates and silently refill the allowance.
  if (now < window.windowStart || now >= window.windowEnd) {
    return null;
  }

  return window;
}

/**
 * Chooses which grants a usage charge draws from. Grants are expected in
 * consumption order (earliest expiry first); anything the grants cannot cover
 * comes back as `uncoveredCredits` so callers can decide how to surface it.
 */
export function planCreditGrantConsumption(input: {
  grants: { id: string; creditsRemaining: number }[];
  credits: number;
}): { consumed: { id: string; consume: number }[]; uncoveredCredits: number } {
  const plan = input.grants.reduce(
    (state, grant) => {
      if (state.remaining <= 0) {
        return state;
      }
      const available = Math.floor(grant.creditsRemaining);
      if (available <= 0) {
        return state;
      }
      const consume = Math.min(available, state.remaining);

      return {
        consumed: [...state.consumed, { id: grant.id, consume }],
        remaining: state.remaining - consume,
      };
    },
    {
      consumed: [] as { id: string; consume: number }[],
      remaining: Math.max(0, Math.floor(input.credits)),
    },
  );

  return { consumed: plan.consumed, uncoveredCredits: plan.remaining };
}

/**
 * The workspace charge order: the member's derived monthly allowance first
 * (no grant rows — unused allowance simply evaporates at window end), then
 * the shared workspace top-up pool. Suspended/removed members pass
 * allowanceCredits 0 and draw pool-only.
 */
export function planWorkspaceCreditDraw(input: {
  credits: number;
  allowanceCredits: number;
  allowanceUsedBefore: number;
  poolGrants: { id: string; creditsRemaining: number }[];
}): { fromAllowance: number; poolConsumed: { id: string; consume: number }[]; uncoveredCredits: number } {
  const credits = Math.max(0, Math.floor(input.credits));
  const allowanceRemaining = Math.max(
    0,
    Math.floor(input.allowanceCredits) - Math.max(0, Math.floor(input.allowanceUsedBefore)),
  );
  const fromAllowance = Math.min(credits, allowanceRemaining);
  const pool = planCreditGrantConsumption({
    grants: input.poolGrants,
    credits: credits - fromAllowance,
  });

  return {
    fromAllowance,
    poolConsumed: pool.consumed,
    uncoveredCredits: pool.uncoveredCredits,
  };
}

// --- Stripe customers ---------------------------------------------------------

export async function getWorkspaceBillingCustomer(workspaceId: string): Promise<WorkspaceBillingCustomerRow | null> {
  return db.workspaceBillingCustomers.findUnique({ where: { workspaceId } });
}

export async function upsertWorkspaceBillingCustomer(input: {
  workspaceId: string;
  stripeCustomerId: string;
}): Promise<WorkspaceBillingCustomerRow> {
  return db.workspaceBillingCustomers.upsert({
    where: { workspaceId: input.workspaceId },
    create: { workspaceId: input.workspaceId, stripeCustomerId: input.stripeCustomerId },
    update: { stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() },
  });
}

export async function getWorkspaceIdForStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  const customer = await db.workspaceBillingCustomers.findUnique({ where: { stripeCustomerId } });

  return customer?.workspaceId ?? null;
}

// --- Subscriptions -------------------------------------------------------------

export async function upsertWorkspaceBillingSubscription(input: {
  workspaceId: string;
  /** The admin who owns the Stripe relationship (billing_subscriptions.user_id stays NOT NULL). */
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  planInterval: string;
  includedCreditsPerPeriod: number;
  seatQuantity: number;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  /** @external Stripe subscription payload */
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<BillingSubscriptionRow> {
  const values = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    status: input.status,
    statusChangedAt: new Date(),
    planInterval: input.planInterval,
    includedCreditsPerPeriod: Math.max(0, Math.floor(input.includedCreditsPerPeriod)),
    seatQuantity: Math.max(1, Math.floor(input.seatQuantity)),
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    /** @external Stripe subscription payload */
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    metadata: toInputJsonRecord(input.metadata ?? {}),
  };

  const now = new Date();
  if (isEntitledSubscriptionStatus(input.status)) {
    await db.billingSubscriptions.updateMany({
      where: {
        workspaceId: input.workspaceId,
        stripeSubscriptionId: { not: input.stripeSubscriptionId },
        status: { in: [...ENTITLED_SUBSCRIPTION_STATUSES] },
        currentPeriodEnd: { lte: now },
      },
      data: { status: "superseded", statusChangedAt: now, updatedAt: now },
    });
  }

  const existing = await db.billingSubscriptions.findUnique({
    where: { stripeSubscriptionId: input.stripeSubscriptionId },
  });
  if (existing === null) {
    return toBillingSubscription(await db.billingSubscriptions.create({ data: values }));
  }

  const updated = await db.billingSubscriptions.updateManyAndReturn({
    where: { stripeSubscriptionId: input.stripeSubscriptionId },
    data: {
      ...values,
      statusChangedAt: existing.status === input.status ? existing.statusChangedAt : now,
      updatedAt: now,
    },
  });
  const subscription = updated[0];
  if (subscription === undefined) {
    throw new Error(WORKSPACE_BILLING_SUBSCRIPTION_UPSERT_EMPTY_MESSAGE);
  }

  return toBillingSubscription(subscription);
}

export async function getLatestBillingSubscriptionForWorkspace(
  workspaceId: string,
): Promise<BillingSubscriptionRow | null> {
  const subscription = await db.billingSubscriptions.findFirst({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });

  return subscription === null ? null : toBillingSubscription(subscription);
}

function runningSubscriptionConditions(now: Date): Prisma.billingSubscriptionsWhereInput {
  const pastDueGraceStart = new Date(now.getTime() - BILLING_PAST_DUE_GRACE_DAYS * DAY_MS);

  return {
    AND: [
      {
        OR: [
          { status: { in: [...ENTITLED_SUBSCRIPTION_STATUSES] } },
          { status: "past_due", statusChangedAt: { gt: pastDueGraceStart } },
        ],
      },
      { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
    ],
  };
}

/** The workspace's subscription whose paid period is still running, if any. */
export async function getRunningBillingSubscriptionForWorkspace(input: {
  workspaceId: string;
  executor?: DbExecutor;
  now?: Date;
}): Promise<BillingSubscriptionRow | null> {
  const executor = input.executor ?? db;
  const subscription = await executor.billingSubscriptions.findFirst({
    where: { workspaceId: input.workspaceId, ...runningSubscriptionConditions(input.now ?? new Date()) },
    orderBy: { updatedAt: "desc" },
  });

  return subscription === null ? null : toBillingSubscription(subscription);
}

/** Every workspace-keyed subscription whose paid period is still running. */
export async function getRunningWorkspaceBillingSubscriptions(): Promise<BillingSubscriptionRow[]> {
  const subscriptions = await db.billingSubscriptions.findMany({
    where: { workspaceId: { not: null }, ...runningSubscriptionConditions(new Date()) },
  });

  return subscriptions.map((subscription) => toBillingSubscription(subscription));
}

export async function updateBillingSubscriptionSeatQuantity(input: {
  stripeSubscriptionId: string;
  seatQuantity: number;
}): Promise<void> {
  await db.billingSubscriptions.updateMany({
    where: { stripeSubscriptionId: input.stripeSubscriptionId },
    data: { seatQuantity: Math.max(1, Math.floor(input.seatQuantity)), updatedAt: new Date() },
  });
}

// --- Workspace plan -------------------------------------------------------------

export async function getWorkspacePlan(workspaceId: string): Promise<WorkspacePlan | null> {
  const row = await db.workspaces.findUnique({ where: { id: workspaceId } });
  if (row === null) {
    return null;
  }

  return workspacePlan(row.plan);
}

export async function updateWorkspacePlan(input: { workspaceId: string; plan: WorkspacePlan }): Promise<void> {
  await db.workspaces.updateMany({
    where: { id: input.workspaceId },
    data: { plan: input.plan, updatedAt: new Date() },
  });
}

/** Fallback billing contact when subscription metadata carries no user id. */
export async function getOldestActiveWorkspaceAdminUserId(workspaceId: string): Promise<string | null> {
  const rows = await db.workspaceMemberships.findMany({
    where: {
      workspaceId,
      role: { in: ["owner", "admin"] },
      status: "active",
      users: { deletedAt: null },
    },
  });
  const [oldestAdmin] = [...rows].sort((left, right) => {
    const roleOrder = Number(left.role !== "owner") - Number(right.role !== "owner");
    if (roleOrder !== 0) {
      return roleOrder;
    }

    return left.createdAt.getTime() - right.createdAt.getTime();
  });

  return oldestAdmin?.userId ?? null;
}

/** Seats a running subscription should carry: active, non-deleted members. */
export async function countActiveWorkspaceMembers(workspaceId: string): Promise<number> {
  return db.workspaceMemberships.count({
    where: { workspaceId, status: "active", users: { deletedAt: null } },
  });
}

// --- Workspace credit pool -------------------------------------------------------

export async function createWorkspaceCreditGrant(input: {
  workspaceId: string;
  source: CreditGrantSource;
  credits: number;
  expiresAt?: Date | null;
  stripeReference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<CreditGrantRow | null> {
  const credits = Math.max(0, Math.floor(input.credits));
  if (credits <= 0) {
    return null;
  }

  const grantId = await insertWorkspaceCreditGrant({ ...input, credits });
  if (grantId === null) {
    return null;
  }
  const grant = await db.creditGrants.findUnique({ where: { id: grantId } });
  if (grant === null) {
    return null;
  }

  return toCreditGrant(grant);
}

// stripe_reference is unique only when it is present. Prisma upsert cannot
// keep that partial predicate, so the insert stays ON CONFLICT DO NOTHING.
async function insertWorkspaceCreditGrant(input: {
  workspaceId: string;
  source: CreditGrantSource;
  credits: number;
  expiresAt?: Date | null;
  stripeReference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO credit_grants (
      workspace_id,
      user_id,
      source,
      credits,
      credits_remaining,
      expires_at,
      stripe_reference,
      metadata
    )
    VALUES (
      ${input.workspaceId}::uuid,
      NULL,
      ${input.source},
      ${input.credits},
      ${input.credits},
      ${input.expiresAt ?? null},
      ${input.stripeReference ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  return inserted[0]?.id ?? null;
}

export async function getWorkspaceCreditBalanceData(workspaceId: string): Promise<{
  balance: number;
  topupCredits: number;
  promotionalCredits: number;
  nextExpiry: Date | null;
}> {
  const now = new Date();
  const grants = await db.creditGrants.findMany({
    where: {
      workspaceId,
      creditsRemaining: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  const nextExpiry = grants.reduce<Date | null>((earliest, grant) => {
    if (grant.expiresAt === null) {
      return earliest;
    }
    if (earliest === null || grant.expiresAt < earliest) {
      return grant.expiresAt;
    }

    return earliest;
  }, null);

  return {
    balance: grants.reduce((total, grant) => total + grant.creditsRemaining, 0),
    topupCredits: grants.reduce(
      (total, grant) => total + (grant.source === "credit_topup" ? grant.creditsRemaining : 0),
      0,
    ),
    promotionalCredits: grants.reduce(
      (total, grant) => total + (grant.source === "promotional" ? grant.creditsRemaining : 0),
      0,
    ),
    nextExpiry,
  };
}

// --- Member allowance + trial ----------------------------------------------------

type WorkspaceMemberUsageWindow = {
  executor: DbExecutor;
  workspaceId: string;
  userId: string;
  from: Date;
  to: Date;
  excludeEventId?: string | null;
};

function workspaceMemberUsageQuery(input: WorkspaceMemberUsageWindow) {
  const excludeEventId = input.excludeEventId;

  // Use the actual allowance allocation for new events and the full charge for historical events without an allocation.
  return Prisma.sql`
    SELECT coalesce(sum(coalesce((metadata->>'allowanceCredits')::integer, credits_charged)), 0) AS used
    FROM "ai_credit_usage_events"
    WHERE workspace_id = ${input.workspaceId}::uuid
      AND user_id = ${input.userId}::uuid
      AND created_at >= ${input.from} AND created_at < ${input.to}
      ${
        excludeEventId !== null && excludeEventId !== undefined && excludeEventId !== ""
          ? Prisma.sql`AND id <> ${excludeEventId}::uuid`
          : Prisma.empty
      }
  `;
}

export async function sumWorkspaceMemberUsageBetween(input: WorkspaceMemberUsageWindow): Promise<number> {
  const [row] = await input.executor.$queryRaw<{ used: bigint }[]>(workspaceMemberUsageQuery(input));

  return Number(row?.used ?? 0);
}

async function isActiveWorkspaceMemberWithin(input: {
  executor: DbExecutor;
  workspaceId: string;
  userId: string;
}): Promise<boolean> {
  const row = await input.executor.workspaceMemberships.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
  });

  return row?.status === "active";
}

async function workspaceMemberAllowanceUsage(input: {
  subscription: Awaited<ReturnType<typeof getRunningBillingSubscriptionForWorkspace>>;
  window: ReturnType<typeof getCurrentMonthlyWindow> | null;
  isMemberActive: boolean;
  workspaceId: string;
  userId: string;
}) {
  const allowanceCredits =
    input.subscription !== null && input.window !== null && input.isMemberActive
      ? input.subscription.includedCreditsPerPeriod
      : 0;
  const usageQuery = input.window
    ? workspaceMemberUsageQuery({
        executor: db,
        workspaceId: input.workspaceId,
        userId: input.userId,
        from: input.window.windowStart,
        to: input.window.windowEnd,
      })
    : null;
  // Settled usage and pending holds must share one statement snapshot during concurrent settlement.
  const [totals] =
    usageQuery && input.window
      ? await db.$queryRaw<{ used: bigint; pending: bigint | null }[]>`
        SELECT (${usageQuery}) AS used, sum(allowance_credits) AS pending
        FROM ai_credit_reservations
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND user_id = ${input.userId}::uuid
          AND status = 'reserved'
          AND allowance_window_start = ${input.window.windowStart}
      `
      : [];
  const allowanceUsed = Number(totals?.used ?? 0);

  return {
    allowanceCredits,
    allowanceUsed,
    allowanceRemaining: Math.max(0, allowanceCredits - allowanceUsed - Number(totals?.pending ?? 0)),
    allowanceWindowEnd: input.window?.windowEnd ?? null,
  };
}

/**
 * Everything the notes/prep gates need to know about a member's spending
 * power inside one workspace. The trial is a gate, not a grant: lifetime
 * charged credits in this workspace, honest for pre-existing users thanks to
 * the 0068 backfill. `trialEligible` limits trial farming to the first three
 * workspaces the user has ever recorded usage in (first-usage order — see
 * getWorkspaceTrialUsage for why membership age is not the ranking).
 */
export async function getWorkspaceMemberCreditAccess(input: {
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<{
  /** @external member credit access contract */
  subscriptionActive: boolean;
  seatQuantity: number;
  allowanceCredits: number;
  allowanceUsed: number;
  allowanceRemaining: number;
  allowanceWindowEnd: Date | null;
  poolBalance: number;
  /** @external member credit access contract */
  trialEligible: boolean;
  trialCreditsUsed: number;
  /** @external member credit access contract */
  hasTrialCredits: boolean;
}> {
  const now = input.now ?? new Date();
  const subscription = await getRunningBillingSubscriptionForWorkspace({ workspaceId: input.workspaceId, now });
  const window = subscription?.currentPeriodStart
    ? getCurrentMonthlyWindow({
        anchor: subscription.currentPeriodStart,
        now,
        periodEnd: subscription.currentPeriodEnd,
      })
    : null;
  const isMemberActive = await isActiveWorkspaceMemberWithin({
    executor: db,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const allowance = await workspaceMemberAllowanceUsage({
    subscription,
    window,
    isMemberActive,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const [poolBalance, trial] = await Promise.all([
    getWorkspaceCreditBalanceData(input.workspaceId),
    getWorkspaceTrialUsage(input),
  ]);

  // Entitlement to spend requires an ACTIVE membership: suspension zeroes the
  // allowance above and must equally close the trial (without resetting the
  // usage history — restore resumes exactly where the member left off).
  const isTrialEligible = isMemberActive && trial.isSlotAvailable;

  return {
    /** @external member credit access contract */
    subscriptionActive: subscription !== null && isMemberActive,
    seatQuantity: subscription?.seatQuantity ?? 0,
    allowanceCredits: allowance.allowanceCredits,
    allowanceUsed: allowance.allowanceUsed,
    allowanceRemaining: allowance.allowanceRemaining,
    allowanceWindowEnd: allowance.allowanceWindowEnd,
    poolBalance: isMemberActive ? poolBalance.balance : 0,
    /** @external member credit access contract */
    trialEligible: isTrialEligible,
    trialCreditsUsed: trial.lifetimeUsed,
    /** @external member credit access contract */
    hasTrialCredits: isTrialEligible,
  };
}

type WorkspaceUsageGroup = {
  userId: string;
  workspaceId: string;
  firstUsedAt: Date;
  used: number;
};

const groupWorkspaceUsage = (
  events: { userId: string; workspaceId: string | null; creditsCharged: number; createdAt: Date }[],
): WorkspaceUsageGroup[] => {
  const grouped = new Map<string, WorkspaceUsageGroup>();
  events.forEach((event) => {
    if (event.workspaceId === null) {
      return;
    }
    const key = `${event.userId}:${event.workspaceId}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        userId: event.userId,
        workspaceId: event.workspaceId,
        firstUsedAt: event.createdAt,
        used: event.creditsCharged,
      });

      return;
    }
    current.used += event.creditsCharged;
    if (event.createdAt < current.firstUsedAt) {
      current.firstUsedAt = event.createdAt;
    }
  });

  return [...grouped.values()];
};

const rankWorkspaceUsage = (groups: WorkspaceUsageGroup[]): WorkspaceUsageGroup[] =>
  [...groups].sort((left, right) => {
    const timeOrder = left.firstUsedAt.getTime() - right.firstUsedAt.getTime();
    if (timeOrder !== 0) {
      return timeOrder;
    }
    if (left.workspaceId === right.workspaceId) {
      return 0;
    }

    return left.workspaceId < right.workspaceId ? -1 : 1;
  });

/**
 * Aggregate free-trial spending power for every active member of a workspace.
 * Trial credits remain member-scoped for enforcement, but summing each
 * member's eligible remainder gives Owners an honest workspace-wide total.
 */
export async function getWorkspaceFreeTrialCreditSummary(workspaceId: string): Promise<{
  memberCount: number;
  remainingCredits: number;
}> {
  const members = await db.workspaceMemberships.findMany({
    where: { workspaceId, status: "active", users: { deletedAt: null } },
  });
  const memberIds = [...new Set(members.map((member) => member.userId))];
  if (memberIds.length === 0) {
    return { memberCount: 0, remainingCredits: 0 };
  }
  const events = await db.aiCreditUsageEvents.findMany({
    where: { userId: { in: memberIds }, workspaceId: { not: null } },
  });
  const groupsByUser = groupWorkspaceUsage(events).reduce((grouped, group) => {
    const current = grouped.get(group.userId) ?? [];

    return new Map(grouped).set(group.userId, [...current, group]);
  }, new Map<string, WorkspaceUsageGroup[]>());
  const summary = memberIds.reduce(
    (totals, memberId) => {
      const ranked = rankWorkspaceUsage(groupsByUser.get(memberId) ?? []);
      const currentIndex = ranked.findIndex((group) => group.workspaceId === workspaceId);
      const usageRank = currentIndex === -1 ? null : currentIndex + 1;
      const lifetimeUsed = currentIndex === -1 ? 0 : (ranked[currentIndex]?.used ?? 0);
      const isEligible =
        usageRank !== null ? usageRank <= TRIAL_WORKSPACE_SLOTS : ranked.length < TRIAL_WORKSPACE_SLOTS;
      if (!isEligible) {
        return totals;
      }
      const remainingCredits = Math.max(0, FREE_TRIAL_CREDITS - lifetimeUsed);

      return {
        memberCount: totals.memberCount + 1,
        remainingCredits: totals.remainingCredits + remainingCredits,
      };
    },
    { memberCount: 0, remainingCredits: 0 },
  );

  return summary;
}

/**
 * Trial slots are ranked by the user's FIRST recorded usage per workspace,
 * not by membership rows: memberships hard-delete on removal, so ranking
 * them would let a user burn the trial in three workspaces, leave one, and
 * have a later workspace slide into rank 3. Usage events persist for the
 * lifetime of the account, so a burned slot stays burned. A workspace with
 * no usage yet has a slot only while fewer than three workspaces have ever
 * recorded usage. Membership is deliberately NOT consulted here — the caller
 * gates entitlement on an active membership, so suspension closes the trial
 * without resetting this usage-derived state.
 */
async function getWorkspaceTrialUsage(input: { userId: string; workspaceId: string }): Promise<{
  lifetimeUsed: number;
  isSlotAvailable: boolean;
}> {
  const events = await db.aiCreditUsageEvents.findMany({
    where: { userId: input.userId, workspaceId: { not: null } },
  });
  const ranked = rankWorkspaceUsage(groupWorkspaceUsage(events));
  const currentIndex = ranked.findIndex((group) => group.workspaceId === input.workspaceId);
  const usageRank = currentIndex === -1 ? null : currentIndex + 1;
  const isSlotAvailable =
    usageRank !== null ? usageRank <= TRIAL_WORKSPACE_SLOTS : ranked.length < TRIAL_WORKSPACE_SLOTS;

  return {
    lifetimeUsed: currentIndex === -1 ? 0 : (ranked[currentIndex]?.used ?? 0),
    isSlotAvailable,
  };
}

// --- Seat sync outbox --------------------------------------------------------------

/**
 * Enqueues (or coalesces onto) the workspace's pending seat-sync row. If a
 * worker already claimed that row, bumping updated_at marks it dirty so the
 * resolver leaves a fresh pending sync behind for the latest member count.
 */

export type WorkspaceSeatSyncJob = {
  id: string;
  workspaceId: string;
  reason: string;
  attemptCount: number;
};

/** Claims due pending rows; stale locks (crashed worker) are reclaimable. */

/**
 * Failed attempt: stays pending (so later membership changes keep coalescing
 * onto it) with a backoff, unless the caller gives up, which parks the row as
 * 'failed' for /health/workers to surface.
 */
