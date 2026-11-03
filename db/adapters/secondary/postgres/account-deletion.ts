import { AccountDeletionBillingError } from "../../../domain/persistence-errors";

import { lockAccountWorkspace, withAccountMutation } from "./account-coordination";

export { AccountDeletionBillingError };

const ACCOUNT_DELETION_ERROR_CODE = {
  subscriptionActive: "account_subscription_active",
  checkoutPending: "account_checkout_pending",
  ownerTransferRequired: "workspace_owner_transfer_required",
} as const;

const ACCOUNT_DELETION_MESSAGE = {
  ownerTransferRequired: "Transfer ownership of shared workspaces before deleting your account.",
  subscriptionActiveWorkspace:
    "Cancel the subscription for {workspaceName} in Billing and wait for it to end, or transfer workspace ownership, before deleting your account.",
  subscriptionActivePersonal:
    "Cancel your personal subscription in Billing and wait for it to end before deleting your account.",
  checkoutPending:
    "Finish or resolve your checkout before deleting your account. An open checkout must expire and a processing payment must finish first.",
} as const;

const CLOSED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired", "superseded"] as const;

/**
 * Keep billing management reachable until subscriptions have actually ended.
 * Reserve deletion under the same user/workspace locks as checkout reservation.
 * External cleanup runs after commit; failed cleanup remains safely retryable.
 */
export async function withAccountDeletionBillingGuard<T>(input: { userId: string; run: () => Promise<T> }): Promise<T> {
  await withAccountMutation({
    userIds: [input.userId],
    run: async (tx) => {
      const ownedWorkspaces = await tx.workspaces.findMany({
        where: {
          workspaceMemberships: {
            some: { userId: input.userId, role: "owner" },
          },
        },
        orderBy: { id: "asc" },
      });
      const workspaceIds = ownedWorkspaces.map((workspace) => workspace.id);
      await workspaceIds.reduce(async (previous, workspaceId) => {
        await previous;
        await lockAccountWorkspace({ tx, workspaceId });
      }, Promise.resolve());
      const subscriptions = await tx.billingSubscriptions.findMany({
        where: {
          status: { notIn: [...CLOSED_SUBSCRIPTION_STATUSES] },
          OR: [
            { userId: input.userId, workspaceId: null },
            ...(workspaceIds.length === 0 ? [] : [{ workspaceId: { in: workspaceIds } }]),
          ],
        },
        take: 1,
      });
      const subscription = subscriptions[0];
      if (subscription !== undefined) {
        const workspace = ownedWorkspaces.find((item) => item.id === subscription.workspaceId);
        throw new AccountDeletionBillingError({
          code: ACCOUNT_DELETION_ERROR_CODE.subscriptionActive,
          message:
            workspace !== undefined
              ? ACCOUNT_DELETION_MESSAGE.subscriptionActiveWorkspace.replace("{workspaceName}", workspace.name)
              : ACCOUNT_DELETION_MESSAGE.subscriptionActivePersonal,
        });
      }

      const checkouts = await tx.billingCheckoutAttempts.findMany({
        where: {
          status: { in: ["pending", "processing"] },
          OR: [
            { subjectType: "user", subjectId: input.userId },
            ...(workspaceIds.length === 0 ? [] : [{ subjectType: "workspace", subjectId: { in: workspaceIds } }]),
          ],
        },
        take: 1,
      });
      if (checkouts.length !== 0) {
        throw new AccountDeletionBillingError({
          code: ACCOUNT_DELETION_ERROR_CODE.checkoutPending,
          message: ACCOUNT_DELETION_MESSAGE.checkoutPending,
        });
      }

      const otherMembers =
        workspaceIds.length === 0
          ? []
          : await tx.workspaceMemberships.findMany({
              where: {
                workspaceId: { in: workspaceIds },
                userId: { not: input.userId },
                status: "active",
                users: { deletedAt: null },
              },
              take: 1,
            });
      if (otherMembers.length !== 0) {
        throw new AccountDeletionBillingError({
          code: ACCOUNT_DELETION_ERROR_CODE.ownerTransferRequired,
          message: ACCOUNT_DELETION_MESSAGE.ownerTransferRequired,
        });
      }
      await tx.users.updateMany({
        where: { id: input.userId },
        data: { deletionRequestedAt: new Date() },
      });
    },
  });

  return input.run();
}
