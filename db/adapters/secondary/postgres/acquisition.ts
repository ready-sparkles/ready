import type { Acquisition } from "@readymeet/shared";

import { db, Prisma } from "./client";

const readAttribution = (value: Prisma.JsonValue): Acquisition =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- column stores an Acquisition document and Prisma types it as JSON
  value as Acquisition;

type PaymentTotal = { currency: string; amountMinor: number; count: number };
type PaymentGroup = { firstPaidAt: Date; totals: Map<string, PaymentTotal> };

const activeWorkspaceOwner = async (workspaceId: string): Promise<string | null> => {
  const row = await db.workspaceMemberships.findFirst({
    where: { workspaceId, role: "owner", status: "active" },
  });

  return row?.userId ?? null;
};

const paymentUserId = async (input: { userId?: string; workspaceId?: string }): Promise<string | null> => {
  if (input.userId !== undefined) {
    return input.userId;
  }
  if (input.workspaceId === undefined || input.workspaceId.length === 0) {
    return null;
  }

  return activeWorkspaceOwner(input.workspaceId);
};

export async function recordAcquisitionPayment(input: {
  transactionId: string;
  userId?: string;
  workspaceId?: string;
  amountMinor: number;
  currency: string;
  paidAt: Date;
}): Promise<void> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return;
  }
  const userId = await paymentUserId(input);
  try {
    await db.acquisitionPayments.create({
      data: {
        transactionId: input.transactionId,
        userId,
        workspaceId: input.workspaceId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency.toUpperCase(),
        paidAt: input.paidAt,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}

export async function updateAnalyticsConsent(input: {
  userId: string;
  /** @external existing analytics consent wire field */
  enabled: boolean;
  identity?: Pick<Acquisition, "clientId" | "sessionId" | "sessionCapturedAt">;
}): Promise<void> {
  const current = await db.userAcquisition.findUnique({ where: { userId: input.userId } });
  if (current === null) {
    return;
  }
  await db.userAcquisition.updateMany({
    where: { userId: input.userId },
    data: {
      /** @external existing analytics consent wire field */
      analyticsEnabled: input.enabled,
      attribution: { ...input.identity, ...readAttribution(current.attribution) },
    },
  });
}

const addPayment = (input: {
  groups: Map<string, PaymentGroup>;
  row: { userId: string | null; currency: string; amountMinor: number; paidAt: Date };
}): Map<string, PaymentGroup> => {
  const { groups, row } = input;
  if (row.userId === null) {
    return groups;
  }
  const current = groups.get(row.userId);
  const totals = new Map(current?.totals ?? []);
  const existing = totals.get(row.currency);
  const next = new Map(groups);
  totals.set(row.currency, {
    currency: row.currency,
    amountMinor: (existing?.amountMinor ?? 0) + row.amountMinor,
    count: (existing?.count ?? 0) + 1,
  });
  next.set(row.userId, {
    firstPaidAt: current === undefined || row.paidAt < current.firstPaidAt ? row.paidAt : current.firstPaidAt,
    totals,
  });

  return next;
};

export async function getAdminAcquisition(userIds: string[]): Promise<
  Map<
    string,
    {
      attribution: Acquisition;
      /** @external existing admin acquisition wire field */
      analyticsEnabled: boolean;
      firstPaidAt: string | null;
      payments: PaymentTotal[];
    }
  >
> {
  if (userIds.length === 0) {
    return new Map();
  }
  const [acquisitions, payments] = await Promise.all([
    db.userAcquisition.findMany({
      where: { userId: { in: userIds } },
    }),
    db.acquisitionPayments.findMany({
      where: { userId: { in: userIds } },
    }),
  ]);
  const grouped = payments.reduce(
    (groups, row) =>
      addPayment({
        groups,
        row: {
          userId: row.userId,
          currency: row.currency,
          amountMinor: Number(row.amountMinor),
          paidAt: row.paidAt,
        },
      }),
    new Map<string, PaymentGroup>(),
  );

  return new Map(
    acquisitions.map((row) => {
      const payment = grouped.get(row.userId);

      return [
        row.userId,
        {
          attribution: readAttribution(row.attribution),
          /** @external existing admin acquisition wire field */
          analyticsEnabled: row.analyticsEnabled,
          firstPaidAt: payment?.firstPaidAt.toISOString() ?? null,
          payments: payment === undefined ? [] : [...payment.totals.values()],
        },
      ];
    }),
  );
}
