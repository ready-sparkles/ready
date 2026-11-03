import { randomUUID } from "node:crypto";
import { z } from "zod";

import { BillingReservationError } from "../../../domain/persistence-errors";

import { type AccountTransaction, lockAccountWorkspace, withAccountMutation } from "./account-coordination";
import type { Prisma } from "./client";
import { db } from "./client";

const BILLING_SUBJECT_UNAVAILABLE_MESSAGE = "Billing account is unavailable or scheduled for deletion.";
const BILLING_SUBJECT_CHANGED_MESSAGE = "Workspace ownership changed; retry checkout.";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;

const BILLING_CHECKOUT_ERROR_MAX_LENGTH = 4_000;

const CHECKOUT_EXPIRE_REQUIRED_MESSAGE = "Previous checkout must be expired at Stripe before replacement";
const CHECKOUT_CHANGED_MESSAGE = "Checkout changed while expiring; retry after payment reconciliation";
const OPEN_CHECKOUT_STATUSES = ["pending", "processing"];
const RETRYABLE_CHECKOUT_STATUSES = ["pending", "processing"];
const COMPLETABLE_CHECKOUT_STATUSES = ["pending", "processing", "failed"];

export type BillingCheckoutSubjectType = "user" | "workspace";
export type BillingCheckoutKind = "subscription" | "topup";

export type BillingCheckoutAttempt = {
  id: string;
  requestKey: string;
  checkoutUrl: string | null;
  stripeCheckoutSessionId: string | null;
  expiresAt: Date | null;
  /** @external existing checkout attempt field */
  processing?: boolean;
};

type OpenCheckout = {
  id: string;
  requestKey: string;
  requestParams: Prisma.JsonValue;
  checkoutUrl: string | null;
  stripeCheckoutSessionId: string | null;
  expiresAt: Date | null;
  status: string;
};

type CheckoutProgressRow = { kind: string; status: string; createdAt: Date };

const checkoutParamsMatch = ({ left, right }: { left: unknown; right: Record<string, unknown> }): boolean =>
  JSON.stringify(left ?? {}) === JSON.stringify(right);

const isJsonInput = (value: unknown): value is Prisma.InputJsonValue => {
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => entry === null || isJsonInput(entry));
  }

  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => entry === null || isJsonInput(entry))
  );
};

const BILLING_ERROR_FALLBACK = "Unknown billing error";

const checkoutRequestParams = (value: Record<string, unknown>): Prisma.InputJsonValue => {
  if (!isJsonInput(value)) {
    throw new Error(BILLING_ERROR_FALLBACK);
  }

  return value;
};

const errorText = ({ error, maxLength }: { error: unknown; maxLength: number }): string => {
  if (error instanceof Error) {
    return error.message.slice(0, maxLength);
  }
  if (typeof error === "string") {
    return error.slice(0, maxLength);
  }

  return BILLING_ERROR_FALLBACK;
};

const checkoutClient = (executor?: AccountTransaction) => executor ?? db;

const findOpenCheckout = async (input: {
  subjectType: BillingCheckoutSubjectType;
  subjectId: string;
  checkoutKind: BillingCheckoutKind;
  executor?: AccountTransaction;
}): Promise<OpenCheckout | undefined> => {
  const row = await checkoutClient(input.executor).billingCheckoutAttempts.findFirst({
    where: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      checkoutKind: input.checkoutKind,
      status: { in: OPEN_CHECKOUT_STATUSES },
    },
    select: {
      id: true,
      requestKey: true,
      requestParams: true,
      checkoutUrl: true,
      stripeCheckoutSessionId: true,
      expiresAt: true,
      status: true,
    },
  });
  if (row === null) {
    return undefined;
  }

  return row;
};

const checkoutIsReusable = ({
  current,
  requestParams,
}: {
  current: OpenCheckout;
  requestParams: Record<string, unknown>;
}): boolean =>
  checkoutParamsMatch({ left: current.requestParams, right: requestParams }) &&
  (current.expiresAt === null || current.expiresAt > new Date());

const toCheckoutAttempt = (current: OpenCheckout): BillingCheckoutAttempt => ({
  id: current.id,
  requestKey: current.requestKey,
  checkoutUrl: current.checkoutUrl,
  stripeCheckoutSessionId: current.stripeCheckoutSessionId,
  expiresAt: current.expiresAt,
  processing: current.status === "processing",
});

const expirePendingCheckout = async (input: {
  current: OpenCheckout;
  expirePreviousSession: ((sessionId: string | null) => Promise<void>) | undefined;
}): Promise<void> => {
  if (input.expirePreviousSession === undefined) {
    throw new Error(CHECKOUT_EXPIRE_REQUIRED_MESSAGE);
  }
  await input.expirePreviousSession(input.current.stripeCheckoutSessionId);
  const expired = await db.billingCheckoutAttempts.updateMany({
    where: { id: input.current.id, status: "pending" },
    data: { status: "expired", updatedAt: new Date() },
  });
  if (expired.count !== 1) {
    throw new Error(CHECKOUT_CHANGED_MESSAGE);
  }
};

const insertPendingCheckout = async (input: {
  subjectType: BillingCheckoutSubjectType;
  subjectId: string;
  checkoutKind: BillingCheckoutKind;
  requestParams: Record<string, unknown>;
  executor: AccountTransaction;
}): Promise<BillingCheckoutAttempt> => {
  const id = randomUUID();
  const requestKey = `readymeet:checkout:${id}`;
  await input.executor.billingCheckoutAttempts.create({
    data: {
      id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      checkoutKind: input.checkoutKind,
      requestKey,
      requestParams: checkoutRequestParams(input.requestParams),
    },
  });

  return { id, requestKey, checkoutUrl: null, stripeCheckoutSessionId: null, expiresAt: null };
};

const checkoutOwnerIds = async (input: { subjectId: string; executor?: AccountTransaction }): Promise<string[]> => {
  const rows = await checkoutClient(input.executor).workspaceMemberships.findMany({
    where: { workspaceId: input.subjectId, role: "owner", status: "active" },
    select: { userId: true },
  });

  return rows.map((row) => row.userId).sort();
};

export async function getOrCreatePendingBillingCheckoutAttempt(input: {
  subjectType: BillingCheckoutSubjectType;
  subjectId: string;
  actorUserId?: string;
  checkoutKind: BillingCheckoutKind;
  requestParams: Record<string, unknown>;
  expirePreviousSession?: (sessionId: string | null) => Promise<void>;
}): Promise<BillingCheckoutAttempt> {
  const ownerIds = input.subjectType === "user" ? [input.subjectId] : await checkoutOwnerIds(input);
  const userIds = [...new Set([...ownerIds, ...(input.actorUserId === undefined ? [] : [input.actorUserId])])];
  const reserved = await withAccountMutation({
    userIds,
    run: async (tx) => {
      if (ownerIds.length === 0) {
        throw new BillingReservationError(BILLING_SUBJECT_UNAVAILABLE_MESSAGE);
      }
      const accounts = await tx.users.findMany({ where: { id: { in: userIds } } });
      if (
        accounts.length !== userIds.length ||
        accounts.some((user) => user.deletedAt !== null || user.deletionRequestedAt !== null)
      ) {
        throw new BillingReservationError(BILLING_SUBJECT_UNAVAILABLE_MESSAGE);
      }
      if (input.subjectType === "workspace") {
        await lockAccountWorkspace({ tx, workspaceId: input.subjectId });
        const currentOwnerIds = await checkoutOwnerIds({ subjectId: input.subjectId, executor: tx });
        if (currentOwnerIds.join(",") !== ownerIds.join(",")) {
          throw new BillingReservationError(BILLING_SUBJECT_CHANGED_MESSAGE);
        }
      }
      const current = await findOpenCheckout({ ...input, executor: tx });
      if (current !== undefined) {
        return { current };
      }

      return { attempt: await insertPendingCheckout({ ...input, executor: tx }) };
    },
  });
  if (reserved.attempt !== undefined) {
    return reserved.attempt;
  }
  const current = reserved.current;
  if (checkoutIsReusable({ current, requestParams: input.requestParams }) || current.status === "processing") {
    return toCheckoutAttempt(current);
  }
  await expirePendingCheckout({ current, expirePreviousSession: input.expirePreviousSession });

  return getOrCreatePendingBillingCheckoutAttempt(input);
}

export async function saveBillingCheckoutSession(input: {
  attemptId: string;
  stripeCheckoutSessionId: string;
  checkoutUrl: string;
  expiresAt: Date | null;
}): Promise<void> {
  await db.billingCheckoutAttempts.updateMany({
    where: { id: input.attemptId, status: "pending" },
    data: {
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      checkoutUrl: input.checkoutUrl,
      expiresAt: input.expiresAt,
      lastError: null,
      updatedAt: new Date(),
    },
  });
}

export async function recordBillingCheckoutAttemptError(input: { attemptId: string; error: unknown }): Promise<void> {
  const rejection = z
    .object({
      type: z.enum(["StripeInvalidRequestError", "StripeAuthenticationError", "StripePermissionError"]),
      statusCode: z.number(),
    })
    .safeParse(input.error);
  const rejectedWithoutSession = new Set([
    HTTP_BAD_REQUEST,
    HTTP_UNAUTHORIZED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_UNPROCESSABLE,
  ]);
  if (rejection.success && rejectedWithoutSession.has(rejection.data.statusCode)) {
    await db.billingCheckoutAttempts.updateMany({
      where: { id: input.attemptId, status: "pending", stripeCheckoutSessionId: null },
      data: { status: "failed", updatedAt: new Date() },
    });
  }
  await db.billingCheckoutAttempts.updateMany({
    where: { id: input.attemptId, status: "pending" },
    data: {
      lastError: errorText({ error: input.error, maxLength: BILLING_CHECKOUT_ERROR_MAX_LENGTH }),
      updatedAt: new Date(),
    },
  });
}

export async function markBillingCheckoutAttemptBySession(input: {
  stripeCheckoutSessionId: string;
  status: "processing" | "completed" | "expired" | "failed";
}): Promise<void> {
  const allowed = input.status === "completed" ? COMPLETABLE_CHECKOUT_STATUSES : RETRYABLE_CHECKOUT_STATUSES;
  await db.billingCheckoutAttempts.updateMany({
    where: {
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      status: { in: allowed },
    },
    data: { status: input.status, updatedAt: new Date() },
  });
}

const latestCreatedAtByKind = (rows: CheckoutProgressRow[]): Map<string, number> =>
  rows.reduce((map, row) => {
    const time = row.createdAt.getTime();
    const current = map.get(row.kind);
    const next = new Map(map);
    if (current === undefined || time > current) {
      next.set(row.kind, time);
    }

    return next;
  }, new Map<string, number>());

const isCheckoutProgress = (
  row: CheckoutProgressRow,
): row is CheckoutProgressRow & { kind: "subscription" | "topup"; status: "processing" | "failed" } =>
  (row.kind === "subscription" || row.kind === "topup") && (row.status === "processing" || row.status === "failed");

const rankCheckoutProgress = (left: CheckoutProgressRow, right: CheckoutProgressRow): number => {
  const statusOrder = Number(left.status !== "processing") - Number(right.status !== "processing");
  if (statusOrder !== 0) {
    return statusOrder;
  }

  return right.createdAt.getTime() - left.createdAt.getTime();
};

/** Only a submitted payment is processing; an abandoned open Checkout is not. */
export async function getWorkspaceCheckoutProgress(workspaceId: string): Promise<{
  kind: "subscription" | "topup";
  status: "processing" | "failed";
  startedAt: string;
} | null> {
  const rows = await db.billingCheckoutAttempts.findMany({
    where: { subjectType: "workspace", subjectId: workspaceId },
    select: { checkoutKind: true, status: true, createdAt: true },
  });
  const progress = rows.map((row) => ({ kind: row.checkoutKind, status: row.status, createdAt: row.createdAt }));
  const latest = latestCreatedAtByKind(progress);
  const candidates = progress
    .filter((row) => row.createdAt.getTime() === latest.get(row.kind))
    .filter(isCheckoutProgress);
  const [chosen] = [...candidates].sort(rankCheckoutProgress);
  if (chosen === undefined) {
    return null;
  }

  return { kind: chosen.kind, status: chosen.status, startedAt: chosen.createdAt.toISOString() };
}

export async function getBillingCheckoutAttemptStatus(sessionId: string): Promise<string | null> {
  const row = await db.billingCheckoutAttempts.findFirst({
    where: { stripeCheckoutSessionId: sessionId },
    select: { status: true },
  });

  return row?.status ?? null;
}

export async function recordStripeWebhookReceipt(input: { stripeEventId: string; eventType: string }): Promise<void> {
  await db.stripeWebhookReceipts.createMany({
    data: [{ stripeEventId: input.stripeEventId, eventType: input.eventType }],
    skipDuplicates: true,
  });
}
export async function hasStripeWebhookReceipt(stripeEventId: string): Promise<boolean> {
  const row = await db.stripeWebhookReceipts.findUnique({
    where: { stripeEventId },
    select: { stripeEventId: true },
  });

  return row !== null;
}

export type ClaimedStripeWebhookEvent = {
  id: string;
  stripeEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attemptCount: number;
};
